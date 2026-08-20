"use client";

import type { CSSProperties, ClipboardEvent, FormEvent, KeyboardEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildAnnotatedSequenceRows, featuresOverlappingRange, motifBasePositions } from "./annotated-sequence";
import type { SequenceOverlay } from "./annotated-sequence";
import { analyzePrimer, findPrimerBindings } from "./molecular-biology";
import { SequenceEdit } from "./sequence-edit";
import { findOpenReadingFrames, findRestrictionSites, RESTRICTION_ENZYMES } from "./sequence-analysis";
import type { SnapGeneFeature, SnapGenePrimer } from "./snapgene";

type Props = {
  sequence: string;
  circular: boolean;
  features: SnapGeneFeature[];
  primers: SnapGenePrimer[];
  motif: string;
  canUndo: boolean;
  canRedo: boolean;
  history: Array<{ description: string; timestamp: string }>;
  onApply: (edit: SequenceEdit) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTopologyChange: (circular: boolean) => void;
  onMotifChange: (motif: string) => void;
  onSaveAnnotation: (featureIndex: number | null, annotation: { name: string; type: string; color: string; start: number; end: number }) => void;
  onRemoveAnnotation: (featureIndex: number) => void;
};

type EditMode = "insert" | "replace" | "delete";
type DirectInputAction = "insert" | "replace" | "paste";
type BaseSelection = { start: number; end: number };
type RestrictionMode = "unique" | "double" | "all";
type AnnotationDraft = { featureIndex: number | null; name: string; type: string; color: string; start: string; end: string };

const numberFormatter = new Intl.NumberFormat("en-US");
const lineWidth = 60;

function sequencePreview(sequence: string, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sequence.length) return "";
  const selected = sequence.slice(start - 1, end);
  return `${selected.slice(0, 28)}${selected.length > 28 ? "…" : ""}`;
}

function cleanClipboardSequence(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(">"))
    .join("")
    .toUpperCase()
    .replace(/[\s\d]/g, "");
}

function isFormControl(target: EventTarget | null) {
  return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function SequenceEditor({
  sequence,
  circular,
  features,
  primers,
  motif,
  canUndo,
  canRedo,
  history,
  onApply,
  onUndo,
  onRedo,
  onTopologyChange,
  onMotifChange,
  onSaveAnnotation,
  onRemoveAnnotation,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragAnchor = useRef(1);
  const dragMoved = useRef(false);
  const [mode, setMode] = useState<EditMode>("insert");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("1");
  const [bases, setBases] = useState("");
  const [error, setError] = useState("");
  const [directError, setDirectError] = useState("");
  const [status, setStatus] = useState("");
  const [selection, setSelection] = useState<BaseSelection | null>(null);
  const [caret, setCaret] = useState(1);
  const [directInputAction, setDirectInputAction] = useState<DirectInputAction | null>(null);
  const [directInput, setDirectInput] = useState("");
  const [showFeatures, setShowFeatures] = useState(true);
  const [showPrimers, setShowPrimers] = useState(true);
  const [showRestrictionSites, setShowRestrictionSites] = useState(false);
  const [showOrfs, setShowOrfs] = useState(false);
  const [showComplement, setShowComplement] = useState(true);
  const [restrictionMode, setRestrictionMode] = useState<RestrictionMode>("unique");
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const primerOverlays = useMemo<SequenceOverlay[]>(() => primers.flatMap((primer, primerIndex) => {
    try {
      return findPrimerBindings(sequence, primer.sequence, circular, { bindingLength: primer.bindingLength }).map((binding, bindingIndex) => ({
        id: `primer-${primerIndex}-${bindingIndex}`,
        kind: "primer" as const,
        name: `${primer.name} ${binding.strand}`,
        color: primer.color ?? "#7655b5",
        strand: binding.strand,
        start: binding.start,
        end: binding.end,
      }));
    } catch {
      return [];
    }
  }), [primers, sequence, circular]);
  const restrictionSites = useMemo(() => findRestrictionSites(sequence, RESTRICTION_ENZYMES, circular), [sequence, circular]);
  const restrictionSiteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    restrictionSites.forEach((site) => counts.set(site.enzyme.name, (counts.get(site.enzyme.name) ?? 0) + 1));
    return counts;
  }, [restrictionSites]);
  const visibleRestrictionSites = useMemo(() => restrictionSites.filter((site) => {
    const count = restrictionSiteCounts.get(site.enzyme.name) ?? 0;
    if (restrictionMode === "all") return true;
    if (restrictionMode === "unique") return count === 1;
    return count <= 2;
  }), [restrictionSites, restrictionSiteCounts, restrictionMode]);
  const orfs = useMemo(() => findOpenReadingFrames(sequence, { minAminoAcids: 50, circular }), [sequence, circular]);
  const overlays = useMemo<SequenceOverlay[]>(() => [
    ...(showPrimers ? primerOverlays : []),
    ...(showRestrictionSites ? visibleRestrictionSites.map((site) => ({
      id: `restriction-${site.id}`,
      kind: "restriction" as const,
      name: site.enzyme.name,
      color: "#1b73a6",
      strand: site.strand,
      start: site.position,
      end: site.end,
    })) : []),
    ...(showOrfs ? orfs.map((orf) => ({
      id: `orf-${orf.id}`,
      kind: "orf" as const,
      name: `ORF ${orf.frame > 0 ? "+" : ""}${orf.frame} · ${orf.aminoAcidLength} aa`,
      color: orf.strand === "+" ? "#f0a23a" : "#58a977",
      strand: orf.strand,
      start: orf.start,
      end: orf.end,
    })) : []),
  ], [showPrimers, primerOverlays, showRestrictionSites, visibleRestrictionSites, showOrfs, orfs]);
  const rows = useMemo(() => buildAnnotatedSequenceRows(sequence, showFeatures ? features : [], lineWidth, overlays), [sequence, showFeatures, features, overlays]);
  const motifPositions = useMemo(() => motifBasePositions(sequence, motif), [sequence, motif]);
  const selectedText = selection ? sequence.slice(selection.start - 1, selection.end) : "";
  const selectedStats = useMemo(() => {
    if (!selectedText) return null;
    const canonicalLength = selectedText.match(/[ACGT]/g)?.length ?? 0;
    const gcBases = selectedText.match(/[GC]/g)?.length ?? 0;
    let meltingTemperature: number | null = null;
    if (/^[ACGT]+$/.test(selectedText)) meltingTemperature = analyzePrimer(selectedText).meltingTemperature;
    return {
      gcPercent: canonicalLength ? (gcBases / canonicalLength) * 100 : 0,
      meltingTemperature,
    };
  }, [selectedText]);
  const selectedFeatures = useMemo(
    () => selection ? featuresOverlappingRange(features, sequence.length, selection.start, selection.end) : [],
    [features, selection, sequence.length],
  );
  const selectedPreview = useMemo(() => sequencePreview(sequence, Number(start), Number(end)), [sequence, start, end]);

  useEffect(() => {
    const stopDragging = () => { dragging.current = false; };
    window.addEventListener("mouseup", stopDragging);
    return () => window.removeEventListener("mouseup", stopDragging);
  }, []);

  function flashStatus(message: string) {
    setStatus(message);
    window.setTimeout(() => setStatus(""), 1800);
  }

  function undoEdit() {
    setSelection(null);
    setCaret(1);
    onUndo();
  }

  function redoEdit() {
    setSelection(null);
    setCaret(1);
    onRedo();
  }

  function reverseComplementDirect() {
    try {
      onApply({ kind: "reverse-complement" });
      setSelection(null);
      setCaret(1);
      setStart("1");
      setEnd("1");
      flashStatus("Sequence reverse complemented");
    } catch (caught) {
      setDirectError(caught instanceof Error ? caught.message : "The sequence could not be reverse complemented.");
    }
  }

  function openNewAnnotation() {
    if (!selection) {
      setDirectError("Select bases before creating an annotation.");
      return;
    }
    setAnnotationDraft({ featureIndex: null, name: "", type: "misc_feature", color: "#2aa99a", start: String(selection.start), end: String(selection.end) });
    setDirectError("");
  }

  function openAnnotationEditor(featureIndex: number) {
    const feature = features[featureIndex];
    if (!feature) return;
    const segment = feature.segments.find(({ start: segmentStart, end: segmentEnd }) => segmentStart !== null && segmentEnd !== null);
    const range = feature.range?.match(/(\d+)\s*-\s*(\d+)/);
    setAnnotationDraft({
      featureIndex,
      name: feature.name,
      type: feature.type,
      color: feature.color ?? "#2aa99a",
      start: String(segment?.start ?? (Number(range?.[1]) || 1)),
      end: String(segment?.end ?? (Number(range?.[2]) || sequence.length)),
    });
    setDirectError("");
  }

  function submitAnnotationDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!annotationDraft) return;
    const name = annotationDraft.name.trim();
    const startCoordinate = Number(annotationDraft.start);
    const endCoordinate = Number(annotationDraft.end);
    if (!name) {
      setDirectError("Give the annotation a name.");
      return;
    }
    if (!Number.isInteger(startCoordinate) || !Number.isInteger(endCoordinate) || startCoordinate < 1 || endCoordinate < startCoordinate || endCoordinate > sequence.length) {
      setDirectError(`Use an annotation range between 1 and ${numberFormatter.format(sequence.length)}.`);
      return;
    }
    onSaveAnnotation(annotationDraft.featureIndex, {
      name,
      type: annotationDraft.type.trim() || "misc_feature",
      color: annotationDraft.color,
      start: startCoordinate,
      end: endCoordinate,
    });
    selectRange(startCoordinate, endCoordinate);
    setAnnotationDraft(null);
    flashStatus(annotationDraft.featureIndex === null ? "Annotation added" : "Annotation updated");
  }

  function selectRange(first: number, last: number) {
    const next = {
      start: Math.max(1, Math.min(sequence.length, Math.min(first, last))),
      end: Math.max(1, Math.min(sequence.length, Math.max(first, last))),
    };
    setSelection(next);
    setCaret(Math.min(sequence.length + 1, next.end + 1));
    setStart(String(next.start));
    setEnd(String(next.end));
    setDirectError("");
    surfaceRef.current?.focus({ preventScroll: true });
  }

  function placeCaret(position: number) {
    const next = Math.max(1, Math.min(sequence.length + 1, position));
    setCaret(next);
    setSelection(null);
    setStart(String(next));
    setDirectError("");
  }

  function handleBaseMouseDown(event: MouseEvent<HTMLSpanElement>, position: number) {
    event.preventDefault();
    surfaceRef.current?.focus({ preventScroll: true });
    if (event.shiftKey) {
      const anchor = selection?.start ?? Math.min(caret, sequence.length);
      selectRange(anchor, position);
      return;
    }
    dragging.current = true;
    dragMoved.current = false;
    dragAnchor.current = position;
    const bounds = event.currentTarget.getBoundingClientRect();
    placeCaret(event.clientX >= bounds.left + bounds.width / 2 ? position + 1 : position);
  }

  function handleBaseMouseEnter(event: MouseEvent<HTMLSpanElement>, position: number) {
    if (!dragging.current || event.buttons !== 1) return;
    if (position !== dragAnchor.current) dragMoved.current = true;
    if (dragMoved.current) selectRange(dragAnchor.current, position);
  }

  function applyDirectSequence(value: string, action: DirectInputAction, selectInserted = true) {
    setDirectError("");
    const cleaned = cleanClipboardSequence(value);
    if (!cleaned) {
      setDirectError("Enter DNA bases to use in this edit.");
      return;
    }
    try {
      if (action === "replace" && !selection) throw new Error("Select bases with the mouse before replacing them.");
      if (action === "insert") {
        const insertionPosition = selection?.start ?? caret;
        onApply({ kind: "insert", position: insertionPosition, sequence: cleaned });
        setSelection(null);
        setCaret(insertionPosition + cleaned.length);
        setStart(String(insertionPosition));
        setEnd(String(insertionPosition + cleaned.length - 1));
      } else if (selection) {
        const insertionStart = selection.start;
        onApply({ kind: "replace", start: selection.start, end: selection.end, sequence: cleaned });
        setSelection(selectInserted && cleaned.length ? { start: insertionStart, end: insertionStart + cleaned.length - 1 } : null);
        setCaret(insertionStart + cleaned.length);
        setStart(String(insertionStart));
        setEnd(String(insertionStart + cleaned.length - 1));
      } else {
        onApply({ kind: "insert", position: caret, sequence: cleaned });
        setSelection({ start: caret, end: caret + cleaned.length - 1 });
        setCaret(caret + cleaned.length);
        setStart(String(caret));
        setEnd(String(caret + cleaned.length - 1));
      }
      setDirectInput("");
      setDirectInputAction(null);
      flashStatus(action === "replace" ? "Selection replaced" : action === "insert" ? `${numberFormatter.format(cleaned.length)} bp inserted` : `${numberFormatter.format(cleaned.length)} bp pasted`);
    } catch (caught) {
      setDirectError(caught instanceof Error ? caught.message : "The sequence edit could not be applied.");
    }
  }

  function deleteSelection() {
    setDirectError("");
    try {
      if (!selection) throw new Error("Select bases with the mouse before deleting them.");
      const nextCaret = selection.start;
      onApply({ kind: "delete", start: selection.start, end: selection.end });
      setSelection(null);
      setCaret(nextCaret);
      setStart(String(nextCaret));
      flashStatus("Selection deleted");
    } catch (caught) {
      setDirectError(caught instanceof Error ? caught.message : "The selection could not be deleted.");
    }
  }

  async function copySelection() {
    setDirectError("");
    if (!selection) {
      setDirectError("Select bases with the mouse before copying them.");
      return false;
    }
    try {
      await navigator.clipboard.writeText(selectedText);
      flashStatus(`${numberFormatter.format(selectedText.length)} bp copied`);
      return true;
    } catch {
      setDirectError("Clipboard access was blocked. Use Cmd/Ctrl+C after selecting the bases, or copy from the selected-sequence preview.");
      return false;
    }
  }

  async function cutSelection() {
    if (await copySelection()) deleteSelection();
  }

  async function pasteFromClipboard() {
    setDirectError("");
    try {
      const value = await navigator.clipboard.readText();
      applyDirectSequence(value, "paste");
    } catch {
      setDirectInputAction("paste");
      setDirectError("Clipboard reading was blocked. Paste the DNA into the field below.");
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (isFormControl(event.target)) return;
    event.preventDefault();
    applyDirectSequence(event.clipboardData.getData("text"), "paste");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isFormControl(event.target)) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "a") {
      event.preventDefault();
      selectRange(1, sequence.length);
    } else if (command && key === "c") {
      event.preventDefault();
      void copySelection();
    } else if (command && key === "x") {
      event.preventDefault();
      void cutSelection();
    } else if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoEdit(); else undoEdit();
    } else if (command && key === "y") {
      event.preventDefault();
      redoEdit();
    } else if ((event.key === "Backspace" || event.key === "Delete") && selection) {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === "Backspace" && caret > 1) {
      event.preventDefault();
      const position = caret - 1;
      try { onApply({ kind: "delete", start: position, end: position }); placeCaret(position); } catch (caught) { setDirectError(caught instanceof Error ? caught.message : "The base could not be deleted."); }
    } else if (event.key === "Delete" && caret <= sequence.length) {
      event.preventDefault();
      try { onApply({ kind: "delete", start: caret, end: caret }); placeCaret(caret); } catch (caught) { setDirectError(caught instanceof Error ? caught.message : "The base could not be deleted."); }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      placeCaret(caret - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      placeCaret(caret + 1);
    } else if (/^[ACGTRYSWKMBDHVNU-]$/i.test(event.key)) {
      event.preventDefault();
      applyDirectSequence(event.key, selection ? "replace" : "insert", false);
    }
  }

  function submitDirectInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (directInputAction) applyDirectSequence(directInput, directInputAction);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      if (mode === "insert") onApply({ kind: "insert", position: Number(start), sequence: bases });
      else if (mode === "delete") onApply({ kind: "delete", start: Number(start), end: Number(end) });
      else onApply({ kind: "replace", start: Number(start), end: Number(end), sequence: bases });
      setBases("");
      setSelection(null);
      setCaret(Math.max(1, Math.min(sequence.length + 1, Number(start))));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit could not be applied.");
    }
  }

  return (
    <section className="editor-section" id="editor" aria-labelledby="editor-heading">
      <div className="workspace-section-heading dark-heading">
        <div>
          <span className="panel-kicker">DIRECT SEQUENCE EDITOR</span>
          <h3 id="editor-heading">Select bases. Edit in place.</h3>
        </div>
        <div className="history-controls">
          <button type="button" onClick={undoEdit} disabled={!canUndo} aria-label="Undo last edit">↶ Undo</button>
          <button type="button" onClick={redoEdit} disabled={!canRedo} aria-label="Redo last edit">↷ Redo</button>
        </div>
      </div>

      <div
        ref={surfaceRef}
        className="direct-sequence-surface"
        id="sequence"
        role="textbox"
        aria-label="Mouse-selectable annotated DNA sequence editor"
        aria-multiline="true"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      >
        <div className="direct-editor-toolbar">
          <div className="selection-tools" role="toolbar" aria-label="Clipboard and selection actions">
            <button type="button" onClick={() => void cutSelection()} disabled={!selection}>Cut <kbd>⌘X</kbd></button>
            <button type="button" onClick={() => void copySelection()} disabled={!selection}>Copy <kbd>⌘C</kbd></button>
            <button type="button" onClick={() => void pasteFromClipboard()}>Paste <kbd>⌘V</kbd></button>
            <button type="button" onClick={() => { setDirectInputAction("insert"); setDirectInput(""); }}>Insert</button>
            <button type="button" onClick={() => { setDirectInputAction("replace"); setDirectInput(""); }} disabled={!selection}>Replace</button>
            <button type="button" onClick={deleteSelection} disabled={!selection}>Delete</button>
            <button type="button" onClick={() => selectRange(1, sequence.length)}>Select all</button>
            <button type="button" className="annotate-selection-button" onClick={openNewAnnotation} disabled={!selection}>+ Annotate</button>
            <button type="button" className="reverse-complement-button" onClick={reverseComplementDirect}>⇄ Reverse complement</button>
          </div>
          <label className="motif-search direct-motif-search">
            <span>Find motif</span>
            <input value={motif} onChange={(event) => onMotifChange(event.target.value.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, ""))} placeholder="e.g. GAATTC" spellCheck={false} />
          </label>
        </div>

        <div className="sequence-overlay-toolbar" role="toolbar" aria-label="Sequence overlays">
          <span>SHOW IN SEQUENCE</span>
          <button type="button" className={showFeatures ? "active features" : "features"} aria-pressed={showFeatures} onClick={() => setShowFeatures((current) => !current)}><i />Features <b>{features.length}</b></button>
          <button type="button" className={showPrimers ? "active primers" : "primers"} aria-pressed={showPrimers} onClick={() => setShowPrimers((current) => !current)}><i />Primers <b>{primerOverlays.length}</b></button>
          <button type="button" className={showRestrictionSites ? "active restrictions" : "restrictions"} aria-pressed={showRestrictionSites} onClick={() => setShowRestrictionSites((current) => !current)}><i />Restriction sites <b>{visibleRestrictionSites.length}</b></button>
          <button type="button" className={showOrfs ? "active orfs" : "orfs"} aria-pressed={showOrfs} onClick={() => setShowOrfs((current) => !current)}><i />ORFs <b>{orfs.length}</b></button>
          <button type="button" className={showComplement ? "active complement" : "complement"} aria-pressed={showComplement} onClick={() => setShowComplement((current) => !current)}><i />Complement</button>
          {showRestrictionSites && <label><span>Enzymes</span><select value={restrictionMode} onChange={(event) => setRestrictionMode(event.target.value as RestrictionMode)}><option value="unique">Unique cutters</option><option value="double">1–2 cutters</option><option value="all">All sites</option></select></label>}
        </div>

        <div className="selection-inspector" aria-live="polite">
          <div>
            <span>{selection ? "SELECTION" : "INSERTION CARET"}</span>
            <strong>{selection ? `${numberFormatter.format(selection.start)}–${numberFormatter.format(selection.end)}` : numberFormatter.format(caret)}</strong>
            <small>{selection
              ? `${numberFormatter.format(selectedText.length)} bp · ${selectedStats?.gcPercent.toFixed(1)}% GC${selectedStats?.meltingTemperature === null ? "" : ` · ${selectedStats?.meltingTemperature.toFixed(1)}°C Tm`}`
              : "Click a base edge to reposition"}</small>
          </div>
          <code>{selection ? `${selectedText.slice(0, 80)}${selectedText.length > 80 ? "…" : ""}` : "Drag across bases to select · Shift-click extends · keyboard shortcuts work here"}</code>
          <div className="selection-feature-chips">
            {selectedFeatures.slice(0, 5).map((feature, index) => {
              const featureIndex = features.indexOf(feature);
              return <span key={`${feature.name}-${index}`} style={{ borderColor: feature.color ?? "#17b6c9" }}><b>{feature.name}</b><button type="button" onClick={() => openAnnotationEditor(featureIndex)}>Edit</button><button type="button" onClick={() => onRemoveAnnotation(featureIndex)} aria-label={`Remove ${feature.name}`}>×</button></span>;
            })}
            {selectedFeatures.length > 5 && <span>+{selectedFeatures.length - 5}</span>}
          </div>
          {status && <b>{status}</b>}
        </div>

        {directInputAction && (
          <form className="direct-sequence-input" onSubmit={submitDirectInput}>
            <label><span>{directInputAction === "replace" ? `Replace ${selection ? `${selection.start}–${selection.end}` : "selection"} with` : directInputAction === "insert" ? `Insert before ${caret}` : selection ? `Paste over ${selection.start}–${selection.end}` : `Paste before ${caret}`}</span><textarea value={directInput} onChange={(event) => setDirectInput(event.target.value.toUpperCase())} placeholder="ACGT…" spellCheck={false} autoFocus /></label>
            <button className="primary-button compact" type="submit">Apply</button>
            <button className="direct-input-cancel" type="button" onClick={() => { setDirectInputAction(null); setDirectInput(""); setDirectError(""); }}>Cancel</button>
          </form>
        )}
        {annotationDraft && (
          <form className="inline-annotation-form" onSubmit={submitAnnotationDraft}>
            <div><span className="inline-form-kicker">{annotationDraft.featureIndex === null ? "NEW ANNOTATION" : "EDIT ANNOTATION"}</span><strong>{annotationDraft.featureIndex === null ? "Describe the selected bases" : "Update this feature without leaving the sequence"}</strong></div>
            <label className="inline-annotation-name"><span>Name</span><input value={annotationDraft.name} onChange={(event) => setAnnotationDraft({ ...annotationDraft, name: event.target.value })} placeholder="e.g. promoter" autoFocus /></label>
            <label><span>Start</span><input type="number" min="1" max={sequence.length} value={annotationDraft.start} onChange={(event) => setAnnotationDraft({ ...annotationDraft, start: event.target.value })} /></label>
            <label><span>End</span><input type="number" min="1" max={sequence.length} value={annotationDraft.end} onChange={(event) => setAnnotationDraft({ ...annotationDraft, end: event.target.value })} /></label>
            <label><span>Type</span><input value={annotationDraft.type} onChange={(event) => setAnnotationDraft({ ...annotationDraft, type: event.target.value })} /></label>
            <label className="inline-color-field"><span>Color</span><input type="color" value={annotationDraft.color} onChange={(event) => setAnnotationDraft({ ...annotationDraft, color: event.target.value })} /></label>
            <button className="primary-button compact" type="submit">{annotationDraft.featureIndex === null ? "Add" : "Update"}</button>
            <button className="direct-input-cancel" type="button" onClick={() => { setAnnotationDraft(null); setDirectError(""); }}>Cancel</button>
          </form>
        )}
        {directError && <p className="direct-editor-error" role="alert">{directError}</p>}

        <div className="sequence-scroll-window">
          <div className="sequence-ruler"><span /><div>{Array.from({ length: 6 }, (_, index) => <b key={index}>{index * 10 + 1}</b>)}</div></div>
          {rows.map((row) => (
            <div className="annotated-sequence-row" key={row.start}>
              <span className="sequence-row-coordinate">{numberFormatter.format(row.start)}</span>
              <div className="sequence-row-content">
                {row.laneCount > 0 && (
                  <div className="inline-annotation-grid" style={{ gridTemplateRows: `repeat(${row.laneCount}, 18px)` }}>
                    {row.annotations.map((annotation) => (
                      <button
                        type="button"
                        className={`inline-annotation ${annotation.kind} ${annotation.strand === "+" ? "forward" : annotation.strand === "-" ? "reverse" : ""}`}
                        key={annotation.id}
                        style={{ "--overlay-color": annotation.color, backgroundColor: annotation.color, gridColumn: `${annotation.startOffset + 1} / ${annotation.endOffset + 2}`, gridRow: annotation.lane + 1 } as CSSProperties}
                        title={`${annotation.kind} · ${annotation.name} · ${annotation.start}–${annotation.end}`}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => selectRange(annotation.start, annotation.end)}
                      >
                        <span>{annotation.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="sequence-bases-grid">
                  {[...row.sequence].map((base, localIndex) => {
                    const position = row.start + localIndex;
                    const baseAnnotations = row.annotations.filter((annotation) => annotation.start <= position && annotation.end >= position);
                    const annotationColor = baseAnnotations.filter(({ kind }) => kind !== "restriction").at(-1)?.color;
                    const selected = Boolean(selection && position >= selection.start && position <= selection.end);
                    const selectionStart = selected && (position === selection?.start || localIndex === 0);
                    const selectionEnd = selected && (position === selection?.end || position === row.end);
                    const caretBefore = !selection && caret === position;
                    const caretAfter = !selection && caret === sequence.length + 1 && position === sequence.length;
                    const style = annotationColor ? { "--base-annotation-color": annotationColor } as CSSProperties : undefined;
                    return (
                      <span
                        key={position}
                        className={`sequence-base base-${base.toLowerCase()} ${annotationColor ? "annotated" : ""} ${motifPositions.has(position) ? "motif-hit" : ""} ${selected ? "selected" : ""} ${selectionStart ? "selection-start" : ""} ${selectionEnd ? "selection-end" : ""} ${caretBefore ? "caret-before" : ""} ${caretAfter ? "caret-after" : ""} ${localIndex > 0 && localIndex % 10 === 0 ? "group-start" : ""}`}
                        style={style}
                        title={`${position} · ${base}${baseAnnotations.length ? ` · ${baseAnnotations.map(({ name }) => name).join(", ")}` : ""}`}
                        onMouseDown={(event) => handleBaseMouseDown(event, position)}
                        onMouseEnter={(event) => handleBaseMouseEnter(event, position)}
                      >{base}</span>
                    );
                  })}
                </div>
                {showComplement && <div className="sequence-complement-grid" aria-hidden="true">
                  {[...row.sequence].map((base, localIndex) => <span className={localIndex > 0 && localIndex % 10 === 0 ? "group-start" : ""} key={localIndex}>{({ A: "T", T: "A", C: "G", G: "C" } as Record<string, string>)[base] ?? "N"}</span>)}
                </div>}
              </div>
              <span className="sequence-row-coordinate end">{numberFormatter.format(row.end)}</span>
            </div>
          ))}
        </div>
        <div className="direct-sequence-footer"><span className="base-legend"><i className="a">A</i><i className="c">C</i><i className="g">G</i><i className="t">T</i></span><span>{numberFormatter.format(sequence.length)} bases</span><span>{showFeatures ? `${features.length} features` : "features hidden"} · {showPrimers ? `${primerOverlays.length} primer sites` : "primers hidden"} · {showRestrictionSites ? `${visibleRestrictionSites.length} restriction sites` : "restriction sites hidden"}{showOrfs ? ` · ${orfs.length} ORFs` : ""}</span></div>
      </div>

      <div className="editor-grid compact-editor-grid">
        <form className="edit-form" onSubmit={submit}>
          <span className="editor-label">COORDINATE EDITOR</span>
          <div className="edit-mode-tabs" role="tablist" aria-label="Sequence edit type">
            {(["insert", "replace", "delete"] as const).map((item) => (
              <button type="button" role="tab" aria-selected={mode === item} className={mode === item ? "active" : ""} key={item} onClick={() => { setMode(item); setError(""); }}>{item}</button>
            ))}
          </div>
          <div className="edit-fields">
            <label><span>{mode === "insert" ? "Insert before" : "Start"}</span><input type="number" min="1" max={mode === "insert" ? sequence.length + 1 : sequence.length} value={start} onChange={(event) => setStart(event.target.value)} /></label>
            {mode !== "insert" && <label><span>End</span><input type="number" min={start || "1"} max={sequence.length} value={end} onChange={(event) => setEnd(event.target.value)} /></label>}
            {mode !== "delete" && <label className="edit-bases"><span>{mode === "insert" ? "DNA to insert" : "Replacement DNA"}</span><textarea value={bases} onChange={(event) => setBases(event.target.value.toUpperCase())} placeholder="ACGT…" spellCheck={false} /></label>}
          </div>
          {mode !== "insert" && selectedPreview && <p className="selection-preview"><span>Selected</span><code>{selectedPreview}</code><b>{numberFormatter.format(Number(end) - Number(start) + 1)} bp</b></p>}
          {error && <p className="editor-error" role="alert">{error}</p>}
          <button className="primary-button compact" type="submit">Apply {mode} <span aria-hidden="true">↗</span></button>
        </form>

        <aside className="editor-actions">
          <span className="editor-label">WHOLE-SEQUENCE ACTIONS</span>
          <button type="button" onClick={() => onApply({ kind: "reverse-complement" })}><span>⇄</span><div><strong>Reverse complement</strong><small>Flip bases and remap feature strands</small></div></button>
          <button type="button" onClick={() => onTopologyChange(!circular)}><span>○</span><div><strong>{circular ? "Linearize sequence" : "Circularize sequence"}</strong><small>Change topology without changing bases</small></div></button>
          <div className="editor-safety"><i />Every committed edit is autosaved on this device for crash recovery.</div>
        </aside>

        <aside className="history-panel">
          <span className="editor-label">SESSION HISTORY · {history.length}</span>
          {history.length ? (
            <ol>
              {[...history].reverse().slice(0, 8).map((item, index) => (
                <li key={`${item.timestamp}-${index}`}><span>{history.length - index}</span><div><strong>{item.description}</strong><small>{item.timestamp}</small></div></li>
              ))}
            </ol>
          ) : <p>Your edits will appear here.</p>}
        </aside>
      </div>
    </section>
  );
}
