import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { bindingSitesFromBinding, buildFeature, buildPrimer, featureRowsFromSegments, primerTailAndBinding, type FeatureDraft, type FeatureLocationRow, type PrimerDraft } from "./annotation-workflows";
import { displayIntervals } from "./sequence-selection";
import type { Feature, Primer, PrimerBinding, PrimerBindingSite, PrimerCheck, SequenceSpan, Topology } from "./types";

type CommonProps = {
  documentName: string;
  sequence: string;
  topology: Topology;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
};

function useSheetKeyboard(sheetRef: React.RefObject<HTMLDivElement | null>, onClose: () => void, busy: boolean) {
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    const first = sheet?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !sheet) return;
      const focusable = [...sheet.querySelectorAll<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])")];
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      event.preventDefault();
      focusable[next].focus();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [sheetRef]);
}

function SheetFrame({ title, subtitle, children, footer, sheetRef, busy }: { title: string; subtitle: string; children: React.ReactNode; footer: React.ReactNode; sheetRef: React.RefObject<HTMLDivElement | null>; busy: boolean }) {
  return <div className="modal-backdrop annotation-backdrop"><section className="annotation-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby="annotation-title" aria-busy={busy}>
    <header><div><small>DOTDNA ANNOTATION</small><h2 id="annotation-title">{title}</h2><p>{subtitle}</p></div></header>
    <div className="annotation-sheet-body" inert={busy}>{children}</div>
    <footer>{footer}</footer>
  </section></div>;
}

function defaultFeatureRows(suggested: SequenceSpan[], sequenceLength: number, circular: boolean): FeatureLocationRow[] {
  if (suggested.length) {
    return featureRowsFromSegments(suggested.map((span) => ({ span, color: null, name: null, kind: null })), sequenceLength, circular);
  }
  return [{ start: "1", end: String(Math.min(sequenceLength, 100)), source: [] }];
}

export function FeatureEditor({ documentName, sequence, topology, feature, suggestedIntervals, onClose, onDirtyChange, onSave, onDelete }: CommonProps & {
  feature: Feature | null;
  suggestedIntervals: SequenceSpan[];
  onSave: (feature: Feature) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const circular = topology === "circular";
  const initial = useMemo<FeatureDraft>(() => ({
    id: feature?.id ?? crypto.randomUUID(),
    name: feature?.name ?? "",
    kind: feature?.kind ?? "misc_feature",
    color: feature?.color ?? "#5cc8d7",
    strand: feature?.strand ?? "forward",
    rows: feature ? featureRowsFromSegments(feature.segments.map((segment) => ({ ...segment, color: segment.color === feature.color ? null : segment.color })), sequence.length, circular) : defaultFeatureRows(suggestedIntervals, sequence.length, circular),
    qualifiers: feature?.qualifiers.map((qualifier) => ({ ...qualifier })) ?? [],
    readingFrame: feature?.reading_frame === null || feature?.reading_frame === undefined ? "" : String(feature.reading_frame + 1),
  }), [circular, feature, sequence.length, suggestedIntervals]);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const built = useMemo(() => buildFeature(draft, sequence.length, circular), [circular, draft, sequence.length]);
  const totalLength = built.value?.segments.reduce((sum, segment) => sum + segment.span.end - segment.span.start, 0) ?? 0;
  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm("Discard the unapplied feature changes?")) return;
    onClose();
  };
  useSheetKeyboard(sheetRef, requestClose, saving);
  useEffect(() => dirtyCallbackRef.current(dirty), [dirty]);
  useEffect(() => () => dirtyCallbackRef.current(false), []);

  const updateRow = (index: number, update: Partial<FeatureLocationRow>) => setDraft((current) => ({ ...current, rows: current.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...update } : row) }));
  const updateQualifier = (index: number, field: "name" | "value", value: string) => setDraft((current) => ({ ...current, qualifiers: current.qualifiers.map((qualifier, qualifierIndex) => qualifierIndex === index ? { ...qualifier, [field]: value } : qualifier) }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!built.value) {
      setError(built.errors[0] ?? "Review the feature fields.");
      sheetRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(built.value);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!onDelete || !feature || !window.confirm(`Remove feature “${feature.name}”?`)) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (deleteError) {
      setError(String(deleteError));
    } finally {
      setSaving(false);
    }
  }

  const coordinateInvalid = (row: FeatureLocationRow, field: "start" | "end") => {
    const value = row[field].trim();
    const coordinate = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(coordinate) || coordinate < 1 || coordinate > sequence.length) return true;
    const otherValue = row[field === "start" ? "end" : "start"].trim();
    const other = /^\d+$/.test(otherValue) ? Number(otherValue) : Number.NaN;
    return !circular && Number.isSafeInteger(other) && (field === "start" ? coordinate > other : other > coordinate);
  };

  return <SheetFrame busy={saving} sheetRef={sheetRef} title={feature ? "Edit Feature" : "Add Feature"} subtitle={`${documentName} · ${sequence.length.toLocaleString()} bp · ${topology}`} footer={<>
    <div className="annotation-validation" role="status">{error ?? built.errors[0] ?? built.warnings[0] ?? `${totalLength.toLocaleString()} bp annotated`}</div>
    {feature && onDelete && <button className="danger-button" disabled={saving} onClick={() => void remove()}>Delete Feature</button>}
    <span />
    <button disabled={saving} onClick={requestClose}>Cancel</button>
    <button className="primary-button" disabled={saving || !built.value || !dirty && Boolean(feature)} form="feature-form" type="submit">{saving ? "Saving…" : feature ? "Save Changes" : "Add Feature"}</button>
  </>}>
    <form id="feature-form" onSubmit={(event) => void submit(event)}>
      <fieldset><legend>Identity</legend><div className="annotation-grid identity-grid">
        <label><span>Name</span><input aria-invalid={!draft.name.trim()} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Type</span><input list="feature-kinds" aria-invalid={!draft.kind.trim()} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} /><datalist id="feature-kinds"><option value="CDS" /><option value="gene" /><option value="promoter" /><option value="terminator" /><option value="misc_feature" /><option value="primer_bind" /></datalist></label>
        <label><span>Color</span><div className="color-field"><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><code>{draft.color.toUpperCase()}</code></div></label>
        <label><span>Strand</span><select value={draft.strand} onChange={(event) => setDraft({ ...draft, strand: event.target.value as FeatureDraft["strand"] })}><option value="forward">Forward</option><option value="reverse">Reverse</option><option value="both">Both</option><option value="none">None</option></select></label>
        {draft.kind.toLowerCase() === "cds" && <label><span>Reading frame</span><select value={draft.readingFrame} onChange={(event) => setDraft({ ...draft, readingFrame: event.target.value })}><option value="">Not set</option><option value="1">Frame 1</option><option value="2">Frame 2</option><option value="3">Frame 3</option></select></label>}
      </div></fieldset>
      <fieldset><legend>Location · 1-based inclusive</legend><div className="segment-editor">
        {draft.rows.map((row, index) => <div className="segment-row" key={index}><strong>Segment {index + 1}</strong><label><span>Start</span><input aria-invalid={coordinateInvalid(row, "start")} className="mono" inputMode="numeric" value={row.start} onChange={(event) => updateRow(index, { start: event.target.value })} /></label><label><span>End</span><input aria-invalid={coordinateInvalid(row, "end")} className="mono" inputMode="numeric" value={row.end} onChange={(event) => updateRow(index, { end: event.target.value })} /></label><button disabled={draft.rows.length === 1} type="button" onClick={() => setDraft((current) => ({ ...current, rows: current.rows.filter((_, rowIndex) => rowIndex !== index) }))}>Remove</button></div>)}
        <button className="inline-add" type="button" onClick={() => setDraft((current) => ({ ...current, rows: [...current.rows, { start: "1", end: "1", source: [] }] }))}>＋ Add Segment</button>
        <p>{circular ? "A start greater than the end crosses the circular origin." : "Linear features require the start to be less than or equal to the end."}</p>
      </div></fieldset>
      <fieldset><legend>Qualifiers</legend><div className="qualifier-editor">
        {draft.qualifiers.map((qualifier, index) => <div className="qualifier-row" key={index}><input aria-label={`Qualifier ${index + 1} name`} placeholder="key" value={qualifier.name} onChange={(event) => updateQualifier(index, "name", event.target.value)} /><textarea aria-label={`Qualifier ${index + 1} value`} placeholder="value" rows={2} value={qualifier.value} onChange={(event) => updateQualifier(index, "value", event.target.value)} /><button type="button" onClick={() => setDraft((current) => ({ ...current, qualifiers: current.qualifiers.filter((_, qualifierIndex) => qualifierIndex !== index) }))}>Remove</button></div>)}
        <button className="inline-add" type="button" onClick={() => setDraft((current) => ({ ...current, qualifiers: [...current.qualifiers, { name: "note", value: "" }] }))}>＋ Add Qualifier</button>
      </div></fieldset>
    </form>
  </SheetFrame>;
}

function bindingKey(binding: PrimerBinding) {
  return `${binding.strand}:${binding.span.start}:${binding.span.end}:${binding.bindingLength}`;
}

const STORED_BINDING = "__stored-binding__";

function bindingSitesEqual(left: PrimerBindingSite[], right: PrimerBindingSite[]) {
  if (left.length !== right.length) return false;
  return left.every((site, index) => {
    const candidate = right[index];
    return candidate?.strand === site.strand
      && candidate.span.start === site.span.start
      && candidate.span.end === site.span.end;
  });
}

export function PrimerEditor({ documentName, sequence, topology, primer, onClose, onDirtyChange, onSave, onDelete }: CommonProps & {
  primer: Primer | null;
  onSave: (primer: Primer) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const initial = useMemo<PrimerDraft>(() => ({
    id: primer?.id ?? crypto.randomUUID(),
    name: primer?.name ?? "",
    sequence: primer?.sequence ?? "",
    bindingLength: primer?.binding_length ? String(primer.binding_length) : "20",
    description: primer?.description ?? "",
    color: primer?.color ?? "#79d6e5",
    phosphorylated: primer?.phosphorylated ?? false,
  }), [primer]);
  const [draft, setDraft] = useState(initial);
  const [check, setCheck] = useState<PrimerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const initialBinding = primer?.binding_sites.length ? STORED_BINDING : "";
  const [selectedBinding, setSelectedBinding] = useState(initialBinding);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestToken = useRef(0);
  const analysisInFlight = useRef(false);
  const queuedAnalysis = useRef<(() => void) | null>(null);
  const bindingChoiceTouched = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  const built = useMemo(() => buildPrimer(draft, sequence.length), [draft, sequence.length]);
  const normalized = draft.sequence.replace(/\s/g, "").toUpperCase();
  const numericBindingLength = /^\d+$/.test(draft.bindingLength) ? Number(draft.bindingLength) : null;
  const split = primerTailAndBinding(normalized, numericBindingLength);
  const bindingDefinitionUnchanged = Boolean(primer && built.value && primer.sequence === built.value.sequence && primer.binding_length === built.value.binding_length);
  const selectedBindingSites = useMemo(() => {
    if (selectedBinding === STORED_BINDING) return bindingDefinitionUnchanged ? primer?.binding_sites ?? [] : [];
    const binding = check?.bindings.find((candidate) => bindingKey(candidate) === selectedBinding) ?? null;
    return binding ? bindingSitesFromBinding(binding, sequence.length) : [];
  }, [bindingDefinitionUnchanged, check?.bindings, primer?.binding_sites, selectedBinding, sequence.length]);
  const bindingDirty = !bindingSitesEqual(selectedBindingSites, primer?.binding_sites ?? []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || bindingDirty;
  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm("Discard the unapplied primer changes?")) return;
    onClose();
  };
  useSheetKeyboard(sheetRef, requestClose, saving);
  useEffect(() => dirtyCallbackRef.current(dirty), [dirty]);
  useEffect(() => () => dirtyCallbackRef.current(false), []);

  useEffect(() => {
    const token = ++requestToken.current;
    if (!built.value) {
      setCheck(null);
      setChecking(false);
      return;
    }
    const definitionUnchanged = Boolean(primer && primer.sequence === built.value.sequence && primer.binding_length === built.value.binding_length);
    bindingChoiceTouched.current = false;
    if (!definitionUnchanged) setSelectedBinding("");
    const executeAnalysis = () => {
      if (analysisInFlight.current) {
        queuedAnalysis.current = executeAnalysis;
        return;
      }
      analysisInFlight.current = true;
      setChecking(true);
      void invoke<PrimerCheck[]>("analyze_document_primers", { request: { templateSequence: sequence, circular: topology === "circular", primers: [{ name: built.value!.name, sequence: built.value!.sequence, bindingLength: built.value!.binding_length }] } })
        .then((checks) => {
          if (requestToken.current !== token) return;
          const next = checks[0] ?? null;
          setCheck(next);
          if (!bindingChoiceTouched.current && definitionUnchanged && primer?.binding_sites.length) {
            const matching = next?.bindings.find((binding) => bindingSitesEqual(bindingSitesFromBinding(binding, sequence.length), primer.binding_sites));
            setSelectedBinding(matching ? bindingKey(matching) : STORED_BINDING);
          } else if (!bindingChoiceTouched.current && !primer && next?.bindings.length === 1 && !next.bindingsTruncated) {
            setSelectedBinding(bindingKey(next.bindings[0]));
          }
        })
        .catch((analysisError: unknown) => { if (requestToken.current === token) setError(`Primer analysis failed: ${String(analysisError)}`); })
        .finally(() => {
          analysisInFlight.current = false;
          if (requestToken.current === token) setChecking(false);
          const queued = queuedAnalysis.current;
          queuedAnalysis.current = null;
          queued?.();
        });
    };
    const timeout = window.setTimeout(executeAnalysis, 250);
    return () => {
      window.clearTimeout(timeout);
      if (queuedAnalysis.current === executeAnalysis) queuedAnalysis.current = null;
      if (requestToken.current === token) requestToken.current = token + 1;
    };
  }, [built.value?.sequence, built.value?.binding_length, primer, sequence, topology]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!built.value) {
      setError(built.errors[0] ?? "Review the primer fields.");
      return;
    }
    const replacement: Primer = {
      ...built.value,
      binding_sites: selectedBindingSites,
    };
    setSaving(true);
    setError(null);
    try {
      await onSave(replacement);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!onDelete || !primer || !window.confirm(`Remove primer “${primer.name}”?`)) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (deleteError) {
      setError(String(deleteError));
    } finally {
      setSaving(false);
    }
  }

  const chooseBinding = (value: string) => {
    bindingChoiceTouched.current = true;
    setSelectedBinding(value);
  };

  return <SheetFrame busy={saving} sheetRef={sheetRef} title={primer ? "Edit Primer" : "Add Primer"} subtitle={`${documentName} · template ${sequence.length.toLocaleString()} bp · ${topology}`} footer={<>
    <div className="annotation-validation" role="status">{error ?? built.errors[0] ?? built.warnings[0] ?? (checking ? "Checking template sites…" : check?.headline ?? "Enter a primer sequence")}</div>
    {primer && onDelete && <button className="danger-button" disabled={saving} onClick={() => void remove()}>Delete Primer</button>}
    <span />
    <button disabled={saving} onClick={requestClose}>Cancel</button>
    <button className="primary-button" disabled={saving || checking || !built.value || !dirty && Boolean(primer)} form="primer-form" type="submit">{saving ? "Saving…" : primer ? "Save Changes" : "Add Primer"}</button>
  </>}>
    <form id="primer-form" onSubmit={(event) => void submit(event)}>
      <fieldset><legend>Primer</legend><div className="annotation-grid primer-grid">
        <label><span>Name</span><input aria-invalid={!draft.name.trim()} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Color</span><div className="color-field"><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><code>{draft.color.toUpperCase()}</code></div></label>
        <label className="wide"><span>Sequence · 5′ → 3′</span><textarea className="mono" aria-invalid={Boolean(built.errors.find((item) => item.includes("sequence") || item.includes("symbol")))} rows={3} spellCheck={false} value={draft.sequence} onChange={(event) => setDraft({ ...draft, sequence: event.target.value })} /></label>
        <label><span>3′ binding length</span><input aria-invalid={numericBindingLength === null || numericBindingLength < 1 || numericBindingLength > normalized.length || numericBindingLength > sequence.length} className="mono" inputMode="numeric" value={draft.bindingLength} onChange={(event) => setDraft({ ...draft, bindingLength: event.target.value })} /></label>
        <label className="check-field"><input checked={draft.phosphorylated} type="checkbox" onChange={(event) => setDraft({ ...draft, phosphorylated: event.target.checked })} /><span>5′ phosphorylated</span></label>
        <label className="wide"><span>Description</span><textarea rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div></fieldset>
      <fieldset><legend>Binding split</legend><div className="primer-split-preview" aria-label={`${split.tail.length} base tail and ${split.binding.length} base template-binding region`}><span className="primer-tail"><small>5′ TAIL · {split.tail.length} nt</small><code>{split.tail || "—"}</code></span><i>|</i><span className="primer-binding"><small>3′ BINDING · {split.binding.length} nt</small><code>{split.binding || "—"}</code></span></div></fieldset>
      <fieldset><legend>Thermodynamics and template sites</legend>
        {check?.analysis && <div className="primer-metrics"><span>Binding Tm <strong>{check.analysis.meltingTemperature.toFixed(1)} °C</strong></span><span>Binding GC <strong>{check.analysis.gcPercent.toFixed(1)}%</strong></span><span>Full GC <strong>{check.analysis.fullGcPercent.toFixed(1)}%</strong></span><span>Hairpin <strong>{check.analysis.hairpinScore}</strong></span><span>Self-dimer <strong>{check.analysis.selfDimerScore}</strong></span></div>}
        {check?.action && <p className="sheet-warning">{check.action}</p>}
        <div className="binding-choice-list" role="radiogroup" aria-label="Stored primer binding site"><label><input checked={!selectedBinding} name="binding-site" type="radio" onClick={() => { bindingChoiceTouched.current = true; }} onChange={() => chooseBinding("")} /><span><strong>No stored site</strong><small>Save the primer without attaching a template location.</small></span></label>
          {selectedBinding === STORED_BINDING && <label><input checked name="binding-site" type="radio" onClick={() => { bindingChoiceTouched.current = true; }} onChange={() => chooseBinding(STORED_BINDING)} /><span><strong>Existing stored site</strong><small>This imported site is preserved, but it was not returned by the current validation scan.</small></span></label>}
          {check?.bindings.map((binding) => <label key={bindingKey(binding)}><input checked={selectedBinding === bindingKey(binding)} name="binding-site" type="radio" onClick={() => { bindingChoiceTouched.current = true; }} onChange={() => chooseBinding(bindingKey(binding))} /><span><strong>{binding.strand === "+" ? "Forward" : "Reverse"} · {binding.wrapsOrigin ? `${binding.span.start + 1}–${sequence.length}, 1–${binding.span.end}` : displayIntervals([binding.span])}</strong><small>{binding.mismatchCount} mismatch{binding.mismatchCount === 1 ? "" : "es"} · 3′ match {binding.threePrimeMatchLength} nt · {binding.meltingTemperature.toFixed(1)} °C{binding.mismatches.length ? ` · ${binding.mismatches.slice(0, 8).map((mismatch) => `${mismatch.primerIndex + 1}:${mismatch.primerBase}→${mismatch.templateBase}`).join(", ")}` : ""}</small></span></label>)}</div>
        {check?.bindingsTruncated && <p className="sheet-warning">Showing the first {check.bindings.length.toLocaleString()} possible sites; additional sites were omitted before transfer to keep the app responsive. Lengthen the 3′ binding region for uniqueness.</p>}
      </fieldset>
    </form>
  </SheetFrame>;
}
