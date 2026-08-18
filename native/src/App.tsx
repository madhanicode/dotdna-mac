import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoDocument } from "./demo";
import { findRestrictionSites, type RestrictionSite } from "./restriction-sites";
import { SequenceView } from "./SequenceView";
import type { CommandError, DocumentSummary, DocumentView, Feature, OpenDocument, PcrCommandResult, PrimerCheck } from "./types";

const PlasmidMap = lazy(() => import("./PlasmidMap").then((module) => ({ default: module.PlasmidMap })));

const views: Array<{ id: DocumentView; label: string; shortcut: string }> = [
  { id: "map", label: "Map", shortcut: "⌘1" },
  { id: "sequence", label: "Sequence", shortcut: "⌘2" },
  { id: "features", label: "Features", shortcut: "⌘3" },
  { id: "primers", label: "Primers", shortcut: "⌘4" },
  { id: "history", label: "History", shortcut: "⌘5" },
];

const bottomViews = ["Map Controls", "Find", "Enzymes", "ORFs", "Warnings"] as const;
type BottomView = typeof bottomViews[number];
type Workflow = "PCR" | "Inverse PCR" | "Overlap-Extension PCR" | null;
type Diagnostic = { level: "warn" | "error"; title: string; body: string };
type EditHistory = { undo: OpenDocument[]; redo: OpenDocument[] };

const MAX_EDIT_HISTORY_ENTRIES = 32;
const MAX_EDIT_HISTORY_BASES = 2_000_000;

function appendHistorySnapshot(stack: OpenDocument[], snapshot: OpenDocument) {
  const next = [...stack, snapshot].slice(-MAX_EDIT_HISTORY_ENTRIES);
  const footprint = (document: OpenDocument) => document.length + document.document.history.reduce(
    (sum, entry) => sum + (entry.parent_document?.sequence.length ?? 0),
    0,
  );
  let retainedBases = next.reduce((sum, document) => sum + footprint(document), 0);
  while (next.length > 1 && retainedBases > MAX_EDIT_HISTORY_BASES) {
    retainedBases -= footprint(next[0]);
    next.shift();
  }
  return next;
}

function documentId(summary: DocumentSummary) {
  return `${summary.path ?? summary.document.name}-${Date.now()}`;
}

function asOpenDocument(summary: DocumentSummary): OpenDocument {
  return { ...summary, id: documentId(summary), dirty: false, view: "map", revision: 0 };
}

function Icon({ name }: { name: string }) {
  const drawing = (() => {
    switch (name) {
      case "sidebar": return <><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M7.5 4v12M4.5 7h1M4.5 10h1" /></>;
      case "open": return <><path d="M2.5 6.5h6l1.5 2h7.5l-2 7H4z" /><path d="M3.5 6.5V4.5h5l1.5 2" /></>;
      case "save": return <><path d="M3.5 3.5h11l2 2v11h-13z" /><path d="M6 3.5v5h7v-5M6.5 16.5v-5h7v5" /></>;
      case "undo": return <><path d="M7 5 3 9l4 4" /><path d="M3.5 9H11a5 5 0 0 1 5 5" /></>;
      case "redo": return <><path d="m13 5 4 4-4 4" /><path d="M16.5 9H9a5 5 0 0 0-5 5" /></>;
      case "annotate": return <><path d="M3 5.5h9l5 4.5-5 4.5H3z" /><circle cx="6" cy="10" r="1" /></>;
      case "primer": return <><path d="M3 6c3 0 3 8 6 8s3-8 6-8" /><path d="m13 5 2 1-1 2" /></>;
      case "actions": return <><path d="M7 3.5h6M8.5 3.5v4L4.5 15a1 1 0 0 0 1 1.5h9a1 1 0 0 0 1-1.5l-4-7.5v-4" /><path d="M7 12h6" /></>;
      case "search": return <><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></>;
      case "inspector": return <><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6.5h.01" /></>;
      case "split": return <><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M10 4v12" /></>;
      case "close": return <path d="m5 5 10 10M15 5 5 15" />;
      default: return <circle cx="10" cy="10" r="2" />;
    }
  })();
  return <svg className="icon" aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45">{drawing}</svg>;
}

function ToolButton({ icon, label, disabled, onClick, active }: { icon: string; label: string; disabled?: boolean; onClick?: () => void; active?: boolean }) {
  return (
    <button className={`tool-button${active ? " active" : ""}`} disabled={disabled} onClick={onClick} title={label}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function EmptyWorkspace({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="empty-workspace">
      <div className="empty-mark"><span /><span /><span /></div>
      <h2>Open a DNA document</h2>
      <p>SnapGene, GenBank, FASTA, plain DNA, and DOTDNA projects are supported.</p>
      <button className="primary-button" onClick={onOpen}>Open Document…</button>
    </div>
  );
}

function FeatureTable({ features, selected, onSelect }: { features: Feature[]; selected: number | null; onSelect: (index: number) => void }) {
  return (
    <div className="table-view">
      <div className="table-toolbar"><strong>{features.length} Features</strong><button disabled title="Feature creation is not available in this build.">＋ New Feature</button></div>
      <table>
        <thead><tr><th /><th>Name</th><th>Type</th><th>Range</th><th>Strand</th><th>Length</th></tr></thead>
        <tbody>
          {features.map((feature, index) => {
            const first = feature.segments[0]?.span;
            const length = feature.segments.reduce((sum, segment) => sum + segment.span.end - segment.span.start, 0);
            return (
              <tr className={selected === index ? "selected" : ""} key={`${feature.name}-${index}`} onClick={() => onSelect(index)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(index);
                }
              }} tabIndex={0}>
                <td><i className="feature-chip" style={{ background: feature.color ?? "#5cc8d7" }} /></td>
                <td><strong>{feature.name}</strong></td><td>{feature.kind}</td>
                <td className="mono">{first ? `${(first.start + 1).toLocaleString()} – ${first.end.toLocaleString()}` : "—"}</td>
                <td>{feature.strand}</td><td className="mono">{length.toLocaleString()} bp</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PrimerTable({ document, checks }: { document: OpenDocument; checks: PrimerCheck[] }) {
  return (
    <div className="table-view">
      <div className="table-toolbar"><strong>{document.document.primers.length} Primers</strong><button disabled title="Primer creation is not available in this build.">＋ Add Primer</button></div>
      <table>
        <thead><tr><th /><th>Name</th><th>Sequence (5′ → 3′)</th><th>Binding</th><th>Tail</th><th>Tm</th><th>Status</th></tr></thead>
        <tbody>
          {document.document.primers.map((primer, index) => {
            const bindingLength = primer.binding_length ?? primer.sequence.length;
            const tailLength = Math.max(0, primer.sequence.length - bindingLength);
            const check = checks[index];
            return (
              <tr key={`${primer.name}-${index}`}>
                <td><i className="feature-chip" style={{ background: primer.color ?? "#79d6e5" }} /></td>
                <td><strong>{primer.name}</strong></td><td className="mono sequence-cell">{primer.sequence}</td>
                <td className="mono">{primer.binding_length ? `${bindingLength} nt` : "Not set"}</td><td className="mono">{primer.binding_length ? `${tailLength} nt` : "—"}</td>
                <td className="mono">{check?.analysis ? `${check.analysis.meltingTemperature.toFixed(1)} °C` : "—"}</td>
                <td><span className={`status-pill ${check?.status === "validated" ? "good" : "warn"}`} title={check?.action ?? undefined}>{check?.headline ?? "Checking…"}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryView({ document }: { document: OpenDocument }) {
  return (
    <div className="history-view">
      <div className="history-line" />
      {document.document.history.length === 0 ? <p className="empty-note">No recorded operations in this document.</p> : document.document.history.map((entry, index) => (
        <article key={`${entry.recorded_at}-${index}`}>
          <span className="history-node">{index + 1}</span>
          <div><strong>{entry.description}</strong><p>{entry.operation} · {entry.recorded_at}</p></div>
          <button disabled title="Historical-state restoration is not available in this build.">Open State</button>
        </article>
      ))}
    </div>
  );
}

function Inspector({ active, selectedFeature }: { active: OpenDocument | null; selectedFeature: number | null }) {
  const feature = active && selectedFeature !== null ? active.document.features[selectedFeature] : null;
  if (!active) return <aside className="inspector"><header>INSPECTOR</header><p className="empty-note">Nothing selected</p></aside>;
  return (
    <aside className="inspector">
      <header><span>INSPECTOR</span><button title="Inspector options">•••</button></header>
      {feature ? (
        <>
          <section className="inspector-hero">
            <i style={{ background: feature.color ?? "#5cc8d7" }} />
            <div><small>FEATURE</small><strong>{feature.name}</strong><span>{feature.kind}</span></div>
          </section>
          <section className="property-list">
            <label><span>Name</span><input value={feature.name} readOnly /></label>
            <label><span>Type</span><select value={feature.kind} disabled><option>{feature.kind}</option></select></label>
            <div><span>Direction</span><strong>{feature.strand}</strong></div>
            <div><span>Range</span><strong className="mono">{feature.segments.map((segment) => `${segment.span.start + 1}–${segment.span.end}`).join(", ")}</strong></div>
            <div><span>Length</span><strong className="mono">{feature.segments.reduce((sum, segment) => sum + segment.span.end - segment.span.start, 0).toLocaleString()} bp</strong></div>
          </section>
          <section className="qualifier-list"><h3>Qualifiers</h3>{feature.qualifiers.map((item) => <div key={item.name}><span>{item.name}</span><p>{item.value}</p></div>)}</section>
        </>
      ) : (
        <>
          <section className="inspector-hero document">
            <div><small>DOCUMENT</small><strong>{active.document.name}</strong><span>{active.format}</span></div>
          </section>
          <section className="property-list">
            <div><span>Length</span><strong className="mono">{active.length.toLocaleString()} bp</strong></div>
            <div><span>Topology</span><strong>{active.document.topology}</strong></div>
            <div><span>Molecule</span><strong>{active.document.double_stranded ? "Double-stranded DNA" : "Single-stranded DNA"}</strong></div>
            <div><span>GC content</span><strong className="mono">{active.gcPercent.toFixed(1)}%</strong></div>
            <div><span>Features</span><strong>{active.document.features.length}</strong></div>
            <div><span>Primers</span><strong>{active.document.primers.length}</strong></div>
          </section>
          <section className="inspector-notes"><h3>Description</h3><p>{active.document.notes.description ?? "No description"}</p></section>
        </>
      )}
    </aside>
  );
}

function BottomPanel({ view, active, setView, zoom, setZoom, showEnzymes, setShowEnzymes, primerChecks, restrictionSites, diagnostics }: {
  view: BottomView; active: OpenDocument | null; setView: (view: BottomView) => void; zoom: number; setZoom: (value: number) => void;
  showEnzymes: boolean; setShowEnzymes: (value: boolean) => void;
  primerChecks: PrimerCheck[]; restrictionSites: RestrictionSite[]; diagnostics: Diagnostic[];
}) {
  const warnings = !active ? [] : [
    ...(active.unknownBases ? [{ level: "warn", title: `${active.unknownBases} ambiguous bases`, body: "Confirm these positions before primer design or translation." }] : []),
    ...active.diagnostics.map((item) => ({ level: item.severity === "error" ? "error" : "warn", title: item.message, body: item.action })),
    ...primerChecks.filter((check) => check.status !== "validated").map((check) => ({ level: "warn", title: `${check.name}: ${check.headline}`, body: check.action ?? "Review this primer before PCR." })),
    ...diagnostics,
  ] as Array<{ level: string; title: string; body: string }>;

  return (
    <section className="bottom-panel">
      <nav>{bottomViews.map((item) => <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>{item}{item === "Warnings" && warnings.length > 0 ? <b>{warnings.length}</b> : null}</button>)}</nav>
      <div className="bottom-content">
        {view === "Map Controls" && <div className="map-control-row">
          <label><span>Map zoom</span><input type="range" min="0.72" max="1.18" step="0.02" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
          <label className="switch-label"><input checked={showEnzymes} onChange={(event) => setShowEnzymes(event.target.checked)} type="checkbox" /><i /><span>Restriction sites</span></label>
          <label className="switch-label unavailable" title="Display controls are not available in this build."><input defaultChecked disabled type="checkbox" /><i /><span>Feature labels</span></label>
          <label className="switch-label unavailable" title="Display controls are not available in this build."><input defaultChecked disabled type="checkbox" /><i /><span>Primer sites</span></label>
        </div>}
        {view === "Find" && <div className="find-panel"><input disabled placeholder="Sequence search is not available in this build." /><button disabled>Find Next</button><span>⌘F</span></div>}
        {view === "Enzymes" && (restrictionSites.length ? <div className="enzyme-grid">{restrictionSites.map((site) => <button key={`${site.enzyme}-${site.position}`}>{site.enzyme} <span className="mono">{(site.position + 1).toLocaleString()}</span></button>)}</div> : <div className="empty-note">No sites for the six common enzymes in the active sequence.</div>)}
        {view === "ORFs" && <div className="empty-note">Open reading frames will appear here for the selected translation threshold.</div>}
        {view === "Warnings" && (warnings.length ? <div className="warning-list">{warnings.map((warning, index) => <article className={warning.level} key={`${warning.title}-${index}`}><span>!</span><div><strong>{warning.title}</strong><p>{warning.body}</p></div></article>)}</div> : <div className="empty-note">No current diagnostics. PCR workflows perform separate 3′ binding and thermodynamic checks.</div>)}
      </div>
    </section>
  );
}

function commandError(error: unknown): CommandError {
  if (error && typeof error === "object" && "message" in error && "action" in error) return error as CommandError;
  return { code: "simulation-failed", message: "The simulation could not be completed.", action: String(error) };
}

function WorkflowSheet({ workflow, active, onClose, onCreate }: {
  workflow: Exclude<Workflow, null>; active: OpenDocument; onClose: () => void; onCreate: (result: PcrCommandResult) => void;
}) {
  const primers = active.document.primers;
  const [forwardIndex, setForwardIndex] = useState(0);
  const [reverseIndex, setReverseIndex] = useState(Math.min(1, Math.max(primers.length - 1, 0)));
  const [internalReverseIndex, setInternalReverseIndex] = useState(Math.min(1, Math.max(primers.length - 1, 0)));
  const [internalForwardIndex, setInternalForwardIndex] = useState(0);
  const [result, setResult] = useState<PcrCommandResult | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const explanatory = workflow === "PCR"
    ? "Amplify a region while preserving feature coordinates on a deterministic product."
    : workflow === "Inverse PCR"
      ? "Amplify away from the selected locus to mutate, delete, or linearize a circular template."
      : "Join two PCR fragments using validated primer-encoded overlaps.";

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const forward = primers[forwardIndex];
    const reverse = primers[reverseIndex];
    const internalReverse = primers[internalReverseIndex];
    const internalForward = primers[internalForwardIndex];
    if (!forward || !reverse) {
      setResult(null);
      setError({ code: "primers-required", message: "This document does not contain a selectable primer pair.", action: "Add at least a forward and reverse primer, including explicit 3′ binding lengths." });
      return;
    }
    setBusy(true);
    setResult(null);
    setError(null);
    const mode = workflow === "PCR" ? "standard" : workflow === "Inverse PCR" ? "inverse" : "overlap-extension";
    void invoke<PcrCommandResult>("simulate_pcr_product", {
      request: {
        mode,
        templateName: active.document.name,
        templateSequence: active.document.sequence,
        circular: active.document.topology === "circular",
        forwardPrimer: forward.sequence,
        reversePrimer: reverse.sequence,
        internalReversePrimer: mode === "overlap-extension" ? internalReverse?.sequence ?? null : null,
        internalForwardPrimer: mode === "overlap-extension" ? internalForward?.sequence ?? null : null,
        options: {
          forwardBindingLength: forward.binding_length,
          reverseBindingLength: reverse.binding_length,
          internalReverseBindingLength: internalReverse?.binding_length ?? null,
          internalForwardBindingLength: internalForward?.binding_length ?? null,
          minimumThreePrimeMatch: 8,
          maximumMismatches: null,
          minimumOverlap: 15,
        },
      },
    }).then((next) => {
      if (!cancelled) setResult(next);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(commandError(reason));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [active, forwardIndex, internalForwardIndex, internalReverseIndex, primers, reverseIndex, workflow]);

  const primerSelect = (label: string, value: number, onChange: (value: number) => void) => (
    <label><span>{label}</span><select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {primers.map((primer, index) => <option key={`${primer.name}-${index}`} value={index}>{primer.name} · {primer.binding_length ? `${primer.binding_length} nt 3′` : "binding not set"}</option>)}
    </select></label>
  );

  const forwardTm = result?.product.forwardBinding.meltingTemperature;
  const reverseTm = result?.product.reverseBinding.meltingTemperature;
  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="workflow-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-label={workflow}>
        <header><div><small>ACTION WORKFLOW</small><h2>{workflow}</h2><p>{explanatory}</p></div><button ref={closeRef} onClick={onClose} aria-label={`Close ${workflow}`}><Icon name="close" /></button></header>
        <div className="workflow-steps"><span className="active"><b>1</b> Primers</span><span className={result ? "active" : ""}><b>2</b> Product</span><span className={result ? "active" : ""}><b>3</b> Verify</span></div>
        <div className="workflow-body">
          {primerSelect("Forward primer", forwardIndex, setForwardIndex)}
          {primerSelect("Reverse primer", reverseIndex, setReverseIndex)}
          {workflow === "Overlap-Extension PCR" && <>
            {primerSelect("Internal reverse primer", internalReverseIndex, setInternalReverseIndex)}
            {primerSelect("Internal forward primer", internalForwardIndex, setInternalForwardIndex)}
          </>}
          <div className="workflow-note"><b>3′ validation boundary</b><p>Rust validates only the declared template-binding segment. Non-hybridizing 5′ tails and accepted internal mismatches remain in the predicted sequence and receive product features.</p></div>
          {busy && <div className="workflow-state">Calculating bindings and thermodynamics…</div>}
          {error && <div className="workflow-warning error"><b>{error.message}</b><p>{error.action}</p></div>}
          {result && <>
            <div className="thermo-strip"><div><span>Amplicon</span><strong>{result.product.length.toLocaleString()} bp</strong></div><div><span>Forward Tm</span><strong>{forwardTm?.toFixed(1)} °C</strong></div><div><span>Reverse Tm</span><strong>{reverseTm?.toFixed(1)} °C</strong></div><div><span>ΔTm</span><strong>{Math.abs((forwardTm ?? 0) - (reverseTm ?? 0)).toFixed(1)} °C</strong></div></div>
            <div className="validation-grid">
              <div><span>Forward 3′ match</span><strong>{result.product.forwardBinding.threePrimeMatchLength} exact bases</strong><small>{result.product.forwardBinding.tailLength} nt tail · {result.product.forwardBinding.mismatchCount} mismatch(es)</small></div>
              <div><span>Reverse 3′ match</span><strong>{result.product.reverseBinding.threePrimeMatchLength} exact bases</strong><small>{result.product.reverseBinding.tailLength} nt tail · {result.product.reverseBinding.mismatchCount} mismatch(es)</small></div>
            </div>
            {result.product.warnings.length ? <div className="product-warnings"><strong>Review before ordering or cycling</strong>{result.product.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : <div className="workflow-success">Unique primer pair found with no advisory warnings.</div>}
          </>}
        </div>
        <footer><span>{result ? `${result.product.features.length} deterministic product annotations` : "No product created yet"}</span><button onClick={onClose}>Cancel</button><button className="primary-button" disabled={!result || busy} onClick={() => result && onCreate(result)}>Create PCR Product</button></footer>
      </section>
    </div>
  );
}

export default function App() {
  const [documents, setDocuments] = useState<OpenDocument[]>([asOpenDocument(demoDocument)]);
  const documentsRef = useRef(documents);
  const [activeId, setActiveId] = useState(documents[0].id);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomView, setBottomView] = useState<BottomView>("Map Controls");
  const [selectedFeatures, setSelectedFeatures] = useState<Record<string, number | null>>({ [documents[0].id]: 4 });
  const [projectSearch, setProjectSearch] = useState("");
  const [status, setStatus] = useState("Ready");
  const [monochrome, setMonochrome] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showEnzymes, setShowEnzymes] = useState(true);
  const [workflow, setWorkflow] = useState<Workflow>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [primerChecks, setPrimerChecks] = useState<PrimerCheck[]>([]);
  const [appDiagnostics, setAppDiagnostics] = useState<Diagnostic[]>([]);
  const [documentDiagnostics, setDocumentDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [editHistories, setEditHistories] = useState<Record<string, EditHistory>>({});
  const editHistoriesRef = useRef(editHistories);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const pendingEditIdsRef = useRef(pendingEditIds);
  const [pendingSaveIds, setPendingSaveIds] = useState<Set<string>>(() => new Set());
  const pendingSaveIdsRef = useRef(pendingSaveIds);

  const active = documents.find((document) => document.id === activeId) ?? null;
  const selectedFeature = active ? selectedFeatures[active.id] ?? null : null;
  const activeBusy = active ? pendingEditIds.has(active.id) || pendingSaveIds.has(active.id) : false;
  const canUndo = active ? !activeBusy && (editHistories[active.id]?.undo.length ?? 0) > 0 : false;
  const canRedo = active ? !activeBusy && (editHistories[active.id]?.redo.length ?? 0) > 0 : false;
  const filteredDocuments = useMemo(() => documents.filter((document) => document.document.name.toLowerCase().includes(projectSearch.toLowerCase())), [documents, projectSearch]);
  const restrictionSites = useMemo(() => active ? findRestrictionSites(active.document.sequence, active.document.topology === "circular") : [], [active]);
  const selectFeature = useCallback((index: number) => {
    if (activeId) setSelectedFeatures((current) => ({ ...current, [activeId]: index }));
  }, [activeId]);

  function updateDocuments(update: (current: OpenDocument[]) => OpenDocument[]) {
    const next = update(documentsRef.current);
    documentsRef.current = next;
    setDocuments(next);
  }

  function setPending(setter: (value: Set<string>) => void, reference: { current: Set<string> }, id: string, pending: boolean) {
    const next = new Set(reference.current);
    if (pending) next.add(id);
    else next.delete(id);
    reference.current = next;
    setter(next);
  }

  useEffect(() => {
    let cancelled = false;
    if (!active?.document.primers.length) {
      setPrimerChecks([]);
      return;
    }
    setPrimerChecks([]);
    void invoke<PrimerCheck[]>("analyze_document_primers", {
      request: {
        templateSequence: active.document.sequence,
        circular: active.document.topology === "circular",
        primers: active.document.primers.map((primer) => ({ name: primer.name, sequence: primer.sequence, bindingLength: primer.binding_length })),
      },
    }).then((checks) => {
      if (!cancelled) setPrimerChecks(checks);
    }).catch((error: unknown) => {
      if (!cancelled) setAppDiagnostics((current) => [...current, { level: "error", title: "Primer checks could not run", body: String(error) }]);
    });
    return () => { cancelled = true; };
  }, [active]);

  function setActiveView(view: DocumentView) {
    if (!active) return;
    updateDocuments((current) => current.map((document) => document.id === active.id ? { ...document, view } : document));
  }

  async function openFile() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "DNA documents", extensions: ["dna", "gb", "gbk", "fa", "fasta", "json", "txt"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setStatus(`Opening ${path.split("/").at(-1)}…`);
      const summary = await invoke<DocumentSummary>("open_document", { path });
      const opened = asOpenDocument(summary);
      updateDocuments((current) => [...current, opened]);
      setActiveId(opened.id);
      setSelectedFeatures((current) => ({ ...current, [opened.id]: opened.document.features.length ? 0 : null }));
      setAppDiagnostics([]);
      setStatus(`Opened ${summary.document.name}`);
    } catch (error) {
      setStatus(`Could not open document: ${String(error)}`);
      setAppDiagnostics([{ level: "error", title: "Document could not be opened", body: `${String(error)} Check the file format and try again.` }]);
      setBottomView("Warnings");
      setBottomOpen(true);
    }
  }

  function closeDocument(id: string) {
    if (pendingEditIdsRef.current.has(id) || pendingSaveIdsRef.current.has(id)) {
      setStatus("Wait for the current edit or save to finish before closing this document.");
      return;
    }
    const currentDocuments = documentsRef.current;
    const closing = currentDocuments.find((document) => document.id === id);
    if (closing?.dirty && !window.confirm(`Close ${closing.document.name} without saving your edits?`)) return;
    const index = currentDocuments.findIndex((document) => document.id === id);
    const next = currentDocuments.filter((document) => document.id !== id);
    documentsRef.current = next;
    setDocuments(next);
    setSelectedFeatures((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    setDocumentDiagnostics((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    setEditHistories((current) => {
      const updated = { ...current };
      delete updated[id];
      editHistoriesRef.current = updated;
      return updated;
    });
    if (id === activeId) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? "");
  }

  function undoActiveDocument() {
    if (!active || pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) return;
    const history = editHistoriesRef.current[active.id] ?? { undo: [], redo: [] };
    const previous = history.undo.at(-1);
    if (!previous) return;
    const nextHistories = {
      ...editHistoriesRef.current,
      [active.id]: {
        undo: history.undo.slice(0, -1),
        redo: appendHistorySnapshot(history.redo, active),
      },
    };
    editHistoriesRef.current = nextHistories;
    setEditHistories(nextHistories);
    updateDocuments((current) => current.map((document) => document.id === active.id ? { ...previous, view: active.view, revision: active.revision + 1 } : document));
    setStatus(`Undid sequence edit · ${previous.length.toLocaleString()} bp`);
  }

  function redoActiveDocument() {
    if (!active || pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) return;
    const history = editHistoriesRef.current[active.id] ?? { undo: [], redo: [] };
    const next = history.redo.at(-1);
    if (!next) return;
    const nextHistories = {
      ...editHistoriesRef.current,
      [active.id]: {
        undo: appendHistorySnapshot(history.undo, active),
        redo: history.redo.slice(0, -1),
      },
    };
    editHistoriesRef.current = nextHistories;
    setEditHistories(nextHistories);
    updateDocuments((current) => current.map((document) => document.id === active.id ? { ...next, view: active.view, revision: active.revision + 1 } : document));
    setStatus(`Redid sequence edit · ${next.length.toLocaleString()} bp`);
  }

  async function saveActiveDocument() {
    if (!active || !active.dirty || pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) return;
    const savingDocument = active;
    setPending(setPendingSaveIds, pendingSaveIdsRef, savingDocument.id, true);
    try {
      const existingProjectPath = savingDocument.format === "DOTDNA Project" ? savingDocument.path : null;
      const path = existingProjectPath ?? await saveDialog({
        defaultPath: `${savingDocument.document.name.replace(/\.[^.]+$/, "")}.dotdna.json`,
        filters: [{ name: "DOTDNA project", extensions: ["json"] }],
      });
      if (!path) return;
      setStatus(`Saving ${savingDocument.document.name}…`);
      const summary = await invoke<DocumentSummary>("save_document", { path, document: savingDocument.document });
      const unchanged = documentsRef.current.find((document) => document.id === savingDocument.id)?.revision === savingDocument.revision;
      updateDocuments((current) => current.map((document) => document.id === savingDocument.id ? {
        ...document,
        path: summary.path,
        format: summary.format,
        dirty: document.revision === savingDocument.revision ? false : document.dirty,
      } : document));
      setStatus(unchanged ? `Saved ${savingDocument.document.name}` : `Saved an earlier revision of ${savingDocument.document.name}; newer edits remain unsaved.`);
    } catch (error) {
      setStatus(`Could not save document: ${String(error)}`);
      setAppDiagnostics([{ level: "error", title: "Document could not be saved", body: `${String(error)} Choose another writable location and try again.` }]);
      setBottomView("Warnings");
      setBottomOpen(true);
    } finally {
      setPending(setPendingSaveIds, pendingSaveIdsRef, savingDocument.id, false);
    }
  }

  function chooseWorkflow(next: Exclude<Workflow, null>) {
    setWorkflow(next);
    setActionsOpen(false);
  }

  function createPcrProduct(result: PcrCommandResult) {
    const opened = asOpenDocument(result.document);
    updateDocuments((current) => [...current, opened]);
    setSelectedFeatures((current) => ({ ...current, [opened.id]: opened.document.features.length ? 0 : null }));
    setActiveId(opened.id);
    setWorkflow(null);
    setStatus(`Created ${opened.document.name} · ${result.product.length.toLocaleString()} bp`);
    setDocumentDiagnostics((current) => ({
      ...current,
      [opened.id]: result.product.warnings.map((warning) => ({ level: "warn", title: "PCR design advisory", body: warning })),
    }));
    if (result.product.warnings.length) {
      setBottomView("Warnings");
      setBottomOpen(true);
    }
  }

  async function applySequenceEdit(documentId: string, sequence: string) {
    if (pendingEditIdsRef.current.has(documentId) || pendingSaveIdsRef.current.has(documentId)) {
      throw new Error("Wait for the current edit or save to finish.");
    }
    const editingDocument = documentsRef.current.find((document) => document.id === documentId);
    if (!editingDocument) throw new Error("The edited document is no longer open.");
    setPending(setPendingEditIds, pendingEditIdsRef, documentId, true);
    setStatus(`Applying sequence edit to ${editingDocument.document.name}…`);
    try {
      const summary = await invoke<DocumentSummary>("replace_document_sequence", {
        document: editingDocument.document,
        newSequence: sequence,
      });
      const liveDocument = documentsRef.current.find((document) => document.id === documentId);
      if (!liveDocument || liveDocument.revision !== editingDocument.revision) {
        throw new Error("The document changed while this edit was running; the stale result was discarded.");
      }
      const history = editHistoriesRef.current[documentId] ?? { undo: [], redo: [] };
      const nextHistories = {
        ...editHistoriesRef.current,
        [documentId]: { undo: appendHistorySnapshot(history.undo, editingDocument), redo: [] },
      };
      editHistoriesRef.current = nextHistories;
      setEditHistories(nextHistories);
      updateDocuments((current) => current.map((document) => document.id === documentId && document.revision === editingDocument.revision ? {
        ...document,
        document: summary.document,
        length: summary.length,
        gcPercent: summary.gcPercent,
        unknownBases: summary.unknownBases,
        diagnostics: summary.diagnostics,
        dirty: true,
        revision: document.revision + 1,
      } : document));
      setStatus(`Edited ${editingDocument.document.name} · ${summary.length.toLocaleString()} bp`);
      if (summary.diagnostics.length) {
        setBottomView("Warnings");
        setBottomOpen(true);
      }
    } finally {
      setPending(setPendingEditIds, pendingEditIdsRef, documentId, false);
    }
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (!event.metaKey) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActiveDocument();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoActiveDocument();
        else undoActiveDocument();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onCloseRequested((event) => {
      if (pendingEditIdsRef.current.size || pendingSaveIdsRef.current.size) {
        event.preventDefault();
        window.alert("Wait for the current edit or save to finish before quitting DOTDNA.");
        return;
      }
      if (!documentsRef.current.some((document) => document.dirty)) return;
      event.preventDefault();
      if (window.confirm("Quit DOTDNA without saving your edited documents?")) {
        void getCurrentWindow().destroy();
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><i><span /><span /><span /></i><strong>DOTDNA</strong><em>LAB</em></div>
        <div className="title-document" data-tauri-drag-region>{active?.document.name ?? "No Document"}{active?.dirty ? " •" : ""}</div>
        <div className="title-actions"><button>⌘K</button></div>
      </header>

      <section className="toolbar">
        <div className="tool-group"><ToolButton icon="sidebar" label="Project" active={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)} /><ToolButton icon="open" label="Open" onClick={() => void openFile()} /><ToolButton icon="save" label="Save" disabled={!active?.dirty || activeBusy} onClick={() => void saveActiveDocument()} /></div>
        <div className="tool-divider" />
        <div className="tool-group"><ToolButton icon="undo" label="Undo" disabled={!canUndo} onClick={undoActiveDocument} /><ToolButton icon="redo" label="Redo" disabled={!canRedo} onClick={redoActiveDocument} /></div>
        <div className="tool-divider" />
        <div className="tool-group"><ToolButton icon="annotate" label="Feature" disabled /><ToolButton icon="primer" label="Primer" disabled />
          <div className="action-menu-wrap"><ToolButton icon="actions" label="Actions" active={actionsOpen} disabled={!active} onClick={() => setActionsOpen((value) => !value)} />
            {actionsOpen && <div className="action-menu"><small>MOLECULAR ACTIONS</small><button onClick={() => chooseWorkflow("PCR")}><b>PCR…</b><span>Amplify between primers</span></button><button onClick={() => chooseWorkflow("Inverse PCR")}><b>Inverse PCR…</b><span>Mutate or delete circular DNA</span></button><button onClick={() => chooseWorkflow("Overlap-Extension PCR")}><b>Overlap-Extension PCR…</b><span>Join overlapping products</span></button><hr /><button disabled><b>Restriction Digest…</b><span>Not available in this build</span></button><button disabled><b>Assembly…</b><span>Not available in this build</span></button></div>}
          </div>
        </div>
        <div className="toolbar-spacer" />
        <div className="tool-group compact"><ToolButton icon="search" label="Find" disabled /><ToolButton icon="split" label="Split" disabled /><ToolButton icon="inspector" label="Inspector" active={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)} /></div>
      </section>

      <section className={`workspace${sidebarOpen ? "" : " no-sidebar"}${inspectorOpen ? "" : " no-inspector"}${bottomOpen ? "" : " no-bottom"}`}>
        {sidebarOpen && <aside className="project-sidebar">
          <header><strong>PROJECT</strong><button disabled title="Project creation is not available in this build.">＋</button></header>
          <div className="project-search"><Icon name="search" /><input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Filter files" /></div>
          <section><h3>OPEN DOCUMENTS <span>{documents.length}</span></h3>{filteredDocuments.map((document) => <button className={document.id === activeId ? "active file-row" : "file-row"} key={document.id} onClick={() => setActiveId(document.id)}><i className={document.document.topology} /><span><strong>{document.document.name}</strong><small>{document.length.toLocaleString()} bp · {document.format}</small></span>{document.dirty && <em>●</em>}</button>)}</section>
          <section className="folder-section"><h3>PROJECT FOLDER</h3><p className="folder-empty">No folder is open.</p></section>
          <footer><button disabled title="Folder workspaces are not available in this build.">＋ Open Folder…</button></footer>
        </aside>}

        <section className="document-area">
          <nav className="document-tabs">{documents.length === 0 ? <span>No open documents</span> : documents.map((document) => {
            const busy = pendingEditIds.has(document.id) || pendingSaveIds.has(document.id);
            return <div className={`document-tab${document.id === activeId ? " active" : ""}`} key={document.id}><button className="document-tab-main" onClick={() => setActiveId(document.id)}><i className={document.document.topology} /><span>{document.document.name}</span>{document.dirty && <em>●</em>}</button><button className="document-tab-close" disabled={busy} title={busy ? "Wait for the current edit or save to finish." : undefined} onClick={() => closeDocument(document.id)} aria-label={`Close ${document.document.name}`}>×</button></div>;
          })}</nav>
          {active ? <>
            <nav className="view-tabs">{views.map((view) => <button className={active.view === view.id ? "active" : ""} key={view.id} onClick={() => setActiveView(view.id)} title={view.shortcut}>{view.label}</button>)}<span /><label><input checked={monochrome} onChange={(event) => setMonochrome(event.target.checked)} type="checkbox" /> Monochrome bases</label></nav>
            <div className="view-content">
              {active.view === "map" && <Suspense fallback={<div className="map-loading">Starting accelerated map renderer…</div>}><PlasmidMap name={active.document.name} topology={active.document.topology} sequenceLength={active.length} features={active.document.features} restrictionSites={restrictionSites} selectedFeature={selectedFeature} onSelectFeature={selectFeature} zoom={zoom} showEnzymes={showEnzymes} /></Suspense>}
              {active.view === "sequence" && <SequenceView key={active.id} sequence={active.document.sequence} monochrome={monochrome} disabled={activeBusy} onApply={(sequence) => applySequenceEdit(active.id, sequence)} />}
              {active.view === "features" && <FeatureTable features={active.document.features} selected={selectedFeature} onSelect={selectFeature} />}
              {active.view === "primers" && <PrimerTable document={active} checks={primerChecks} />}
              {active.view === "history" && <HistoryView document={active} />}
            </div>
          </> : <EmptyWorkspace onOpen={() => void openFile()} />}
        </section>

        {inspectorOpen && <Inspector active={active} selectedFeature={selectedFeature} />}
        {bottomOpen && <BottomPanel view={bottomView} active={active} setView={setBottomView} zoom={zoom} setZoom={setZoom} showEnzymes={showEnzymes} setShowEnzymes={setShowEnzymes} primerChecks={primerChecks} restrictionSites={restrictionSites} diagnostics={[...appDiagnostics, ...(active ? documentDiagnostics[active.id] ?? [] : [])]} />}
      </section>

      <footer className="statusbar"><button onClick={() => setBottomOpen((value) => !value)}>{bottomOpen ? "⌄" : "⌃"}</button><span className="status-ready" /> <strong>{status}</strong><div />{active && <><span>{active.document.topology === "circular" ? "Circular" : "Linear"}</span><span>dsDNA</span><span className="mono">{active.length.toLocaleString()} bp</span><span className="mono">GC {active.gcPercent.toFixed(1)}%</span></>}</footer>
      {workflow && active && <WorkflowSheet workflow={workflow} active={active} onClose={() => setWorkflow(null)} onCreate={createPcrProduct} />}
    </main>
  );
}
