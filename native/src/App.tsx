import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { FeatureEditor, PrimerEditor } from "./AnnotationEditors";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { demoDocument } from "./demo";
import { DigestSheet } from "./DigestSheet";
import { restrictionSiteCounts } from "./digest-workflows";
import { canSaveDocument, defaultProjectPath, directProjectPath, documentSavepoint, findOpenDocumentByPath, matchesDocumentSavepoint, nativeMenuPayload, nativeMenuState, nextUntitledName } from "./document-workflows";
import { scanRestrictionSites, type RestrictionSite } from "./restriction-sites";
import { SequenceView } from "./SequenceView";
import { displayIntervals, normalizeIntervals, selectionLength, validateFindQuery, type SequenceMatch, type SequenceSelection } from "./sequence-selection";
import type { CommandError, DigestCommandFragment, DigestCommandResult, DocumentSummary, DocumentView, Feature, OpenDocument, OpenReadingFrame, OrfTranslation, PcrCommandResult, Primer, PrimerCheck, ProjectFolderSummary, SequenceDocument } from "./types";

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
const bottomNavigation: Array<{ label: string; view?: BottomView; reason?: string }> = [
  { label: "Map Controls", view: "Map Controls" },
  { label: "Find", view: "Find" },
  { label: "Enzymes", view: "Enzymes" },
  { label: "ORFs", view: "ORFs" },
  { label: "Warnings", view: "Warnings" },
];
type PcrWorkflow = "PCR" | "Inverse PCR" | "Overlap-Extension PCR";
type Workflow = PcrWorkflow | "Restriction Digest" | null;
type Diagnostic = { level: "warn" | "error"; title: string; body: string };
type EditHistory = { undo: OpenDocument[]; redo: OpenDocument[] };
type CloseRequest = { kind: "document"; id: string } | { kind: "quit" };
type SavePathResolution = { path: string; fileVersion: string | null };
type OrfAnalysisState = { revision: number; minimumAminoAcids: number; loading: boolean; error: string | null; truncated: boolean; items: OpenReadingFrame[] };
type OrfAnalysisResponse = { orfs: OpenReadingFrame[]; truncated: boolean };
type FindAnalysisState = { revision: number; query: string; loading: boolean; error: string | null; capped: boolean; matches: SequenceMatch[] };
type AnnotationEditorState = { kind: "feature" | "primer"; documentId: string; revision: number; index: number | null };
type DocumentMutationResult = { summary: DocumentSummary; changed: boolean; entityIndex: number | null };
type DocumentMutation =
  | { kind: "create-feature"; feature: Feature }
  | { kind: "replace-feature"; index: number; expected: Feature; replacement: Feature }
  | { kind: "delete-feature"; index: number; expected: Feature }
  | { kind: "create-primer"; primer: Primer }
  | { kind: "replace-primer"; index: number; expected: Primer; replacement: Primer }
  | { kind: "delete-primer"; index: number; expected: Primer };

const MAX_FIND_MATCHES = 50_000;

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
  const document = {
    ...summary.document,
    features: summary.document.features.map((feature) => ({ ...feature, id: feature.id ?? crypto.randomUUID() })),
    primers: summary.document.primers.map((primer) => ({ ...primer, id: primer.id ?? crypto.randomUUID() })),
  };
  return { ...summary, document, id: documentId(summary), dirty: false, view: "map", revision: 0 };
}

function cutBoundaryLabel(position: number | null) {
  if (position === null) return "Outside molecule";
  return position === 0 ? "Before base 1" : `After base ${position.toLocaleString()}`;
}

function displayFileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function Icon({ name }: { name: string }) {
  const drawing = (() => {
    switch (name) {
      case "sidebar": return <><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M7.5 4v12M4.5 7h1M4.5 10h1" /></>;
      case "new": return <><path d="M4 2.5h8l4 4v11H4z" /><path d="M12 2.5v4h4M10 9v6M7 12h6" /></>;
      case "open": return <><path d="M2.5 6.5h6l1.5 2h7.5l-2 7H4z" /><path d="M3.5 6.5V4.5h5l1.5 2" /></>;
      case "save": return <><path d="M3.5 3.5h11l2 2v11h-13z" /><path d="M6 3.5v5h7v-5M6.5 16.5v-5h7v5" /></>;
      case "saveAs": return <><path d="M3.5 3.5h9l2 2v7" /><path d="M6 3.5v5h6v-5M6.5 16.5v-5h5" /><path d="m12 15 4-4 1.5 1.5-4 4-2 .5z" /></>;
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

function ToolButton({ icon, label, disabled, disabledReason, onClick, onKeyDown, active, expanded, hasPopup, controls, buttonRef }: { icon: string; label: string; disabled?: boolean; disabledReason?: string; onClick?: ComponentProps<"button">["onClick"]; onKeyDown?: ComponentProps<"button">["onKeyDown"]; active?: boolean; expanded?: boolean; hasPopup?: boolean; controls?: string; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button aria-controls={controls} aria-expanded={expanded} aria-haspopup={hasPopup ? "menu" : undefined} aria-pressed={hasPopup ? undefined : active ?? undefined} className={`tool-button${active ? " active" : ""}`} disabled={disabled} onClick={onClick} onKeyDown={onKeyDown} ref={buttonRef} title={disabled && disabledReason ? disabledReason : label}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function EmptyWorkspace({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <div className="empty-workspace">
      <div className="empty-mark"><span /><span /><span /></div>
      <h2>Open a DNA document</h2>
      <p>SnapGene, GenBank, FASTA, plain DNA, and DOTDNA projects are supported.</p>
      <div className="empty-actions"><button onClick={onNew}>New DNA…</button><button className="primary-button" onClick={onOpen}>Open Document…</button></div>
    </div>
  );
}

function FeatureTable({ features, selected, onSelect, onReveal, onNew, onEdit }: { features: Feature[]; selected: number | null; onSelect: (index: number) => void; onReveal: (index: number) => void; onNew: () => void; onEdit: (index: number) => void }) {
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const moveFocus = (index: number) => {
    onSelect(index);
    window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
  };
  return (
    <div className="table-view">
      <div className="table-toolbar"><strong>{features.length} Features</strong><span /><button disabled={selected === null} onClick={() => selected !== null && onReveal(selected)}>Show in Sequence</button><button disabled={selected === null} onClick={() => selected !== null && onEdit(selected)}>Edit Selected…</button><button onClick={onNew}>＋ New Feature</button></div>
      <table>
        <thead><tr><th /><th>Name</th><th>Type</th><th>Range</th><th>Strand</th><th>Length</th></tr></thead>
        <tbody>
          {features.map((feature, index) => {
            const first = feature.segments[0]?.span;
            const length = feature.segments.reduce((sum, segment) => sum + segment.span.end - segment.span.start, 0);
            return (
              <tr aria-selected={selected === index} className={selected === index ? "selected" : ""} key={feature.id ?? `${feature.name}-${index}`} onClick={() => onSelect(index)} onDoubleClick={() => onEdit(index)} ref={(element) => { rowRefs.current[index] = element; }} onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onEdit(index);
                } else if (event.key === " ") {
                  event.preventDefault();
                  onSelect(index);
                } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const target = event.key === "Home" ? 0 : event.key === "End" ? features.length - 1 : Math.max(0, Math.min(features.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                  moveFocus(target);
                }
              }} tabIndex={index === (selected ?? 0) ? 0 : -1}>
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

function PrimerTable({ document, checks, selected, onSelect, onReveal, onNew, onEdit }: { document: OpenDocument; checks: PrimerCheck[]; selected: number | null; onSelect: (index: number) => void; onReveal: (index: number) => void; onNew: () => void; onEdit: (index: number) => void }) {
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const moveFocus = (index: number) => {
    onSelect(index);
    window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
  };
  return (
    <div className="table-view">
      <div className="table-toolbar"><strong>{document.document.primers.length} Primers</strong><span /><button disabled={selected === null} onClick={() => selected !== null && onReveal(selected)}>Show in Sequence</button><button disabled={selected === null} onClick={() => selected !== null && onEdit(selected)}>Edit Selected…</button><button onClick={onNew}>＋ Add Primer</button></div>
      <table>
        <thead><tr><th /><th>Name</th><th>Sequence (5′ → 3′)</th><th>Binding</th><th>Tail</th><th>Tm</th><th>Status</th></tr></thead>
        <tbody>
          {document.document.primers.map((primer, index) => {
            const bindingLength = primer.binding_length ?? primer.sequence.length;
            const tailLength = Math.max(0, primer.sequence.length - bindingLength);
            const check = checks[index];
            return (
              <tr aria-selected={selected === index} className={selected === index ? "selected" : ""} key={primer.id ?? `${primer.name}-${index}`} onClick={() => onSelect(index)} onDoubleClick={() => onEdit(index)} ref={(element) => { rowRefs.current[index] = element; }} onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); onEdit(index); }
                else if (event.key === " ") { event.preventDefault(); onSelect(index); }
                else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const target = event.key === "Home" ? 0 : event.key === "End" ? document.document.primers.length - 1 : Math.max(0, Math.min(document.document.primers.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                  moveFocus(target);
                }
              }} tabIndex={index === (selected ?? 0) ? 0 : -1}>
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
          <button disabled title="Historical-state restoration is planned but not implemented yet.">Open State</button>
        </article>
      ))}
    </div>
  );
}

function Inspector({ active, selectedFeature, selection }: { active: OpenDocument | null; selectedFeature: number | null; selection: SequenceSelection | null }) {
  const feature = active && selectedFeature !== null && (!selection || selection.source === "feature") ? active.document.features[selectedFeature] : null;
  if (!active) return <aside className="inspector"><header>INSPECTOR</header><p className="empty-note">Nothing selected</p></aside>;
  return (
    <aside className="inspector">
      <header><span>INSPECTOR</span></header>
      {selection && selection.source !== "feature" ? (
        <>
          <section className="inspector-hero">
            <i className={`selection-swatch selection-${selection.source}`} />
            <div><small>{selection.source.toUpperCase()}</small><strong>{selection.label}</strong><span>{selection.detail ?? `${selectionLength(selection).toLocaleString()} bp selected`}</span></div>
          </section>
          <section className="property-list">
            <div><span>Range</span><strong className="mono">{displayIntervals(selection.intervals)}</strong></div>
            <div><span>Length</span><strong className="mono">{selectionLength(selection).toLocaleString()} bp</strong></div>
            <div><span>Direction</span><strong>{selection.strand}</strong></div>
            <div><span>Origin</span><strong>{selection.wrapsOrigin ? "Crosses origin" : "Does not cross"}</strong></div>
            {selection.cutPositions && <><div><span>Top cut</span><strong className="mono">{cutBoundaryLabel(selection.cutPositions.top)}</strong></div><div><span>Bottom cut</span><strong className="mono">{cutBoundaryLabel(selection.cutPositions.bottom)}</strong></div></>}
          </section>
        </>
      ) : feature ? (
        <>
          <section className="inspector-hero">
            <i style={{ background: feature.color ?? "#5cc8d7" }} />
            <div><small>FEATURE</small><strong>{feature.name}</strong><span>{feature.kind}</span></div>
          </section>
          <section className="property-list">
            <div><span>Name</span><strong>{feature.name}</strong></div>
            <div><span>Type</span><strong>{feature.kind}</strong></div>
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

function FindPanel({ query, validationError, loading, count, capped, index, focusToken, onQueryChange, onMove, onClose }: {
  query: string;
  validationError: string | null;
  loading: boolean;
  count: number;
  capped: boolean;
  index: number;
  focusToken: number;
  onQueryChange: (query: string) => void;
  onMove: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusToken]);
  return <div className="find-panel">
    <label><span>DNA / IUPAC sequence</span><input ref={inputRef} spellCheck={false} value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); onMove(event.shiftKey ? -1 : 1); }
      else if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }} placeholder="Find sequence…" aria-invalid={Boolean(validationError)} aria-describedby="find-help" /></label>
    <button disabled={!count} onClick={() => onMove(-1)} aria-label="Previous match">↑</button>
    <button disabled={!count} onClick={() => onMove(1)} aria-label="Next match">↓</button>
    <strong className="mono" aria-live="polite">{validationError ? "Search unavailable" : loading ? "Searching both strands…" : count ? `${Math.min(index + 1, count).toLocaleString()} of ${count.toLocaleString()}${capped ? "+" : ""}` : query ? "No matches" : "Enter a sequence"}</strong>
    <span id="find-help" role={validationError ? "alert" : undefined}>{validationError ?? "Enter / Shift-Enter moves between overlapping matches. DNA ambiguity codes are supported."}</span>
    <button className="find-close" onClick={onClose} aria-label="Close Find">×</button>
  </div>;
}

function OrfPanel({ documentId, state, selectedId, showTranslation, onMinimumChange, onRefresh, onSelect, onShowTranslation }: {
  documentId: string | null;
  state: OrfAnalysisState | null;
  selectedId: string | null;
  showTranslation: boolean;
  onMinimumChange: (minimum: number) => void;
  onRefresh: () => void;
  onSelect: (orf: OpenReadingFrame) => void;
  onShowTranslation: (show: boolean) => void;
}) {
  const items = state?.items ?? [];
  const [page, setPage] = useState(0);
  const pageSize = 200;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const visibleItems = items.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => setPage(0), [documentId, state?.revision, state?.minimumAminoAcids]);
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);
  return <div className="orf-panel">
    <header>
      <label><span>Minimum ORF</span><select value={state?.minimumAminoAcids ?? 20} onChange={(event) => onMinimumChange(Number(event.target.value))}><option value="10">10 aa</option><option value="20">20 aa</option><option value="50">50 aa</option><option value="100">100 aa</option></select></label>
      <label className="switch-label"><input checked={showTranslation} onChange={(event) => onShowTranslation(event.target.checked)} type="checkbox" /><i /><span>Selected translation track</span></label>
      <button disabled={state?.loading} onClick={onRefresh}>{state?.loading ? "Analyzing…" : "Refresh"}</button>
      <strong aria-live="polite">{state?.loading ? "Scanning all six reading frames…" : `${items.length.toLocaleString()}${state?.truncated ? "+" : ""} complete ORFs`}</strong>
      <button disabled={page === 0 || state?.loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button><em>Page {page + 1} of {pageCount}</em><button disabled={page + 1 >= pageCount || state?.loading} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>Next</button>
    </header>
    {state?.error ? <div className="orf-error"><strong>ORF analysis could not run</strong><span>{state.error}</span></div> : items.length ? <div className={`orf-results${state?.truncated ? " has-note" : ""}`}>{state?.truncated && <div className="orf-limit-note">Results reached the balanced per-frame safety limit; every reading frame was scanned, but additional repetitive ORFs are omitted.</div>}<div className="orf-list" role="listbox" aria-label="Open reading frames" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=option]")];
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault();
      options[next]?.focus();
    }}>{visibleItems.map((orf) => <button aria-selected={selectedId === orf.id} className={selectedId === orf.id ? "selected" : ""} key={orf.id} onClick={() => onSelect(orf)} role="option">
      <b>{orf.frame > 0 ? `+${orf.frame}` : orf.frame}</b><span className="mono">{displayIntervals(orf.intervals)}</span><span>{orf.aminoAcidLength.toLocaleString()} aa</span><em>{orf.wrapsOrigin ? "origin-spanning" : orf.strand}</em>
    </button>)}</div></div> : !state?.loading && <div className="empty-note">No complete start-to-stop ORFs meet this length. Lower the minimum or review ambiguous bases.</div>}
  </div>;
}

function BottomPanel({ view, active, setView, zoom, setZoom, showEnzymes, setShowEnzymes, showFeatureLabels, setShowFeatureLabels, showPrimers, setShowPrimers, primerChecks, restrictionSites, restrictionSitesTruncated, selectedRestrictionId, diagnostics, onSelectRestrictionSite, findProps, orfProps }: {
  view: BottomView; active: OpenDocument | null; setView: (view: BottomView) => void; zoom: number; setZoom: (value: number) => void;
  showEnzymes: boolean; setShowEnzymes: (value: boolean) => void;
  showFeatureLabels: boolean; setShowFeatureLabels: (value: boolean) => void;
  showPrimers: boolean; setShowPrimers: (value: boolean) => void;
  primerChecks: PrimerCheck[]; restrictionSites: RestrictionSite[]; diagnostics: Diagnostic[];
  restrictionSitesTruncated: boolean;
  selectedRestrictionId: string | null;
  onSelectRestrictionSite: (site: RestrictionSite) => void;
  findProps: ComponentProps<typeof FindPanel>;
  orfProps: ComponentProps<typeof OrfPanel>;
}) {
  const [enzymePage, setEnzymePage] = useState(0);
  const enzymePageSize = 120;
  const enzymePageCount = Math.max(1, Math.ceil(restrictionSites.length / enzymePageSize));
  const visibleRestrictionSites = restrictionSites.slice(enzymePage * enzymePageSize, (enzymePage + 1) * enzymePageSize);
  useEffect(() => setEnzymePage(0), [active?.id, restrictionSites.length]);
  const warnings = !active ? [] : [
    ...(active.unknownBases ? [{ level: "warn", title: `${active.unknownBases} ambiguous bases`, body: "Confirm these positions before primer design or translation." }] : []),
    ...active.diagnostics.map((item) => ({ level: item.severity === "error" ? "error" : "warn", title: item.message, body: item.action })),
    ...primerChecks.filter((check) => check.status !== "validated").map((check) => ({ level: "warn", title: `${check.name}: ${check.headline}`, body: check.action ?? "Review this primer before PCR." })),
    ...diagnostics,
  ] as Array<{ level: string; title: string; body: string }>;

  return (
    <section className="bottom-panel">
      <nav>{bottomNavigation.map((item) => {
        const requiresDocument = item.label === "Find" || item.label === "Enzymes" || item.label === "ORFs";
        const disabled = !item.view || (requiresDocument && !active);
        return <button className={view === item.view ? "active" : ""} disabled={disabled} key={item.label} onClick={() => item.view && setView(item.view)} title={disabled && requiresDocument ? "Open a DNA document first." : item.reason}>{item.label}{item.label === "Warnings" && warnings.length > 0 ? <b>{warnings.length}</b> : null}</button>;
      })}</nav>
      <div className="bottom-content">
        {view === "Map Controls" && <div className="map-control-row">
          <label><span>Map zoom</span><input type="range" min="0.72" max="1.18" step="0.02" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
          <label className="switch-label"><input checked={showEnzymes} onChange={(event) => setShowEnzymes(event.target.checked)} type="checkbox" /><i /><span>Restriction sites</span></label>
          <label className="switch-label"><input checked={showFeatureLabels} onChange={(event) => setShowFeatureLabels(event.target.checked)} type="checkbox" /><i /><span>Feature labels</span></label>
          <label className="switch-label"><input checked={showPrimers} onChange={(event) => setShowPrimers(event.target.checked)} type="checkbox" /><i /><span>Primer sites</span></label>
        </div>}
        {view === "Find" && <FindPanel {...findProps} />}
        {view === "Enzymes" && (restrictionSites.length ? <div className="enzyme-browser"><header><strong>{restrictionSites.length.toLocaleString()}{restrictionSitesTruncated ? "+" : ""} common-enzyme sites</strong>{restrictionSitesTruncated && <span>Repetitive hits are capped at 1,000 per enzyme. Use Find with the recognition sequence to inspect additional matches.</span>}<button disabled={enzymePage === 0} onClick={() => setEnzymePage((page) => Math.max(0, page - 1))}>Previous</button><em>Page {enzymePage + 1} of {enzymePageCount}</em><button disabled={enzymePage + 1 >= enzymePageCount} onClick={() => setEnzymePage((page) => Math.min(enzymePageCount - 1, page + 1))}>Next</button></header><div className="enzyme-grid">{visibleRestrictionSites.map((site) => {
          const entityId = `restriction:${site.enzyme}:${site.position}:${site.orientation}`;
          return <button aria-pressed={selectedRestrictionId === entityId} className={`enzyme-site${selectedRestrictionId === entityId ? " selected" : ""}`} key={`${site.enzyme}-${site.position}-${site.orientation}`} onClick={() => onSelectRestrictionSite(site)}><strong>{site.enzyme}</strong><span className="mono">{site.orientation === "reverse" ? "←" : "→"} {(site.position + 1).toLocaleString()}</span><small>{site.recognitionSequence}</small></button>;
        })}</div></div> : <div className="empty-note">No sites for the six common enzymes in the active sequence.</div>)}
        {view === "ORFs" && <OrfPanel {...orfProps} />}
        {view === "Warnings" && (warnings.length ? <div className="warning-list">{warnings.map((warning, index) => <article className={warning.level} key={`${warning.title}-${index}`}><span>!</span><div><strong>{warning.title}</strong><p>{warning.body}</p></div></article>)}</div> : <div className="empty-note">No current diagnostics. PCR workflows perform separate 3′ binding and thermodynamic checks.</div>)}
      </div>
    </section>
  );
}

function NewDocumentSheet({ suggestedName, onClose, onCreate }: {
  suggestedName: string;
  onClose: () => void;
  onCreate: (request: { name: string; sequence: string; circular: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState(suggestedName);
  const [sequence, setSequence] = useState("");
  const [circular, setCircular] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedLength = sequence.replace(/[\s\d]/g, "").length;
  const hasDraft = name !== suggestedName || normalizedLength > 0 || circular;

  function requestClose() {
    if (busy) return;
    if (hasDraft && !window.confirm("Discard this new-document draft?")) return;
    onClose();
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || (event.metaKey && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  async function submit() {
    if (!name.trim() || normalizedLength === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name, sequence, circular });
    } catch (submitError) {
      setError(String(submitError));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section className="new-document-sheet" role="dialog" aria-modal="true" aria-label="New DNA document">
        <header><div><small>NEW DOCUMENT</small><h2>Create DNA</h2><p>Start with a named sequence, then annotate, design primers, and save it as a DOTDNA project.</p></div><button disabled={busy} onClick={requestClose} aria-label="Close"><Icon name="close" /></button></header>
        <div className="new-document-fields">
          <label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Untitled DNA" /></label>
          <fieldset><legend>Topology</legend><label><input checked={!circular} onChange={() => setCircular(false)} type="radio" name="topology" /> Linear</label><label><input checked={circular} onChange={() => setCircular(true)} type="radio" name="topology" /> Circular</label></fieldset>
          <label><span>DNA sequence</span><textarea spellCheck={false} value={sequence} onChange={(event) => setSequence(event.target.value)} placeholder="Paste A, C, G, T, or supported ambiguity codes…" /></label>
          <div className="new-document-meta"><span className="mono">{normalizedLength.toLocaleString()} bases</span><span>The new document remains unsaved until you choose Save.</span></div>
          {error && <div className="workflow-warning error"><b>Document could not be created</b><p>{error}</p></div>}
        </div>
        <footer><span>{busy ? "Creating document…" : "Coordinates will use the entered sequence as position 1."}</span><button disabled={busy} onClick={requestClose}>Cancel</button><button className="primary-button" disabled={busy || !name.trim() || normalizedLength === 0} onClick={() => void submit()}>{busy ? "Creating…" : "Create Document"}</button></footer>
      </section>
    </div>
  );
}

function SplitWorkspace({ ratio, onRatioChange, focusedPane, onFocusPane, map, sequence }: {
  ratio: number;
  onRatioChange: (ratio: number) => void;
  focusedPane: "map" | "sequence";
  onFocusPane: (pane: "map" | "sequence") => void;
  map: ReactNode;
  sequence: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const clamp = (value: number) => Math.max(24, Math.min(72, value));
  const updateFromPointer = (clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return;
    onRatioChange(clamp((clientY - bounds.top) / bounds.height * 100));
  };
  return <div className={`split-workspace${resizing ? " resizing" : ""}`} ref={containerRef} style={{ gridTemplateRows: `minmax(110px, ${ratio}fr) 7px minmax(120px, ${100 - ratio}fr)` }} onPointerMove={(event) => { if (resizing) updateFromPointer(event.clientY); }} onPointerUp={(event) => { if (resizing) { updateFromPointer(event.clientY); setResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); } }}>
    <section className={`split-pane map-pane${focusedPane === "map" ? " focused" : ""}`} onFocusCapture={() => onFocusPane("map")} onMouseDown={() => onFocusPane("map")}><header><strong>MAP</strong><span>Shared selection</span></header>{map}</section>
    <div className="split-divider" role="separator" aria-label="Resize Map and Sequence panes" aria-orientation="horizontal" aria-valuemin={24} aria-valuemax={72} aria-valuenow={Math.round(ratio)} tabIndex={0} onDoubleClick={() => onRatioChange(44)} onPointerDown={(event) => { setResizing(true); event.currentTarget.parentElement?.setPointerCapture(event.pointerId); updateFromPointer(event.clientY); }} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") onRatioChange(44);
      else onRatioChange(clamp(ratio + (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 10 : 2)));
    }}><i /></div>
    <section className={`split-pane sequence-pane${focusedPane === "sequence" ? " focused" : ""}`} onFocusCapture={() => onFocusPane("sequence")} onMouseDown={() => onFocusPane("sequence")}><header><strong>SEQUENCE</strong><span>Synchronized coordinates</span></header>{sequence}</section>
  </div>;
}

function UnsavedChangesSheet({ documentNames, quitting, busy, onCancel, onDiscard, onSave }: {
  documentNames: string[];
  quitting: boolean;
  busy: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const multiple = documentNames.length > 1;
  const subject = multiple ? `${documentNames.length} edited documents` : documentNames[0] ?? "this document";
  return (
    <div className="sheet-backdrop">
      <section className="unsaved-sheet" role="alertdialog" aria-modal="true" aria-label="Unsaved changes">
        <div className="unsaved-symbol">!</div>
        <div><h2>Save changes before {quitting ? "quitting" : "closing"}?</h2><p>{subject} {multiple ? "have" : "has"} changes that have not been saved. Unsaved changes will be lost.</p>{multiple && <ul>{documentNames.map((name) => <li key={name}>{name}</li>)}</ul>}</div>
        <footer><button disabled={busy} className="destructive-button" onClick={onDiscard}>Don’t Save</button><span /><button disabled={busy} onClick={onCancel}>Cancel</button><button disabled={busy} className="primary-button" onClick={onSave}>{busy ? "Saving…" : multiple ? "Save All" : "Save"}</button></footer>
      </section>
    </div>
  );
}

function commandError(error: unknown): CommandError {
  if (error && typeof error === "object" && "message" in error && "action" in error) return error as CommandError;
  return { code: "simulation-failed", message: "The simulation could not be completed.", action: String(error) };
}

function WorkflowSheet({ workflow, active, onClose, onCreate, onBusyChange }: {
  workflow: PcrWorkflow; active: OpenDocument; onClose: () => void; onCreate: (result: PcrCommandResult) => void; onBusyChange: (busy: boolean) => void;
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
  const closeCallbackRef = useRef(onClose);
  const busyRef = useRef(busy);
  const simulationTokenRef = useRef(0);
  const simulationInFlightRef = useRef(false);
  const queuedSimulationRef = useRef<(() => void) | null>(null);
  const busyChangeRef = useRef(onBusyChange);
  closeCallbackRef.current = onClose;
  busyRef.current = busy;
  busyChangeRef.current = onBusyChange;
  const explanatory = workflow === "PCR"
    ? "Amplify a region while preserving feature coordinates on a deterministic product."
    : workflow === "Inverse PCR"
      ? "Amplify away from the selected locus to mutate, delete, or linearize a circular template."
      : "Join two PCR fragments using validated primer-encoded overlaps.";

  useEffect(() => busyChangeRef.current(busy), [busy]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeCallbackRef.current();
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
  }, []);

  useEffect(() => {
    const token = ++simulationTokenRef.current;
    const forward = primers[forwardIndex];
    const reverse = primers[reverseIndex];
    const internalReverse = primers[internalReverseIndex];
    const internalForward = primers[internalForwardIndex];
    setBusy(true);
    setResult(null);
    setError(null);
    const mode = workflow === "PCR" ? "standard" : workflow === "Inverse PCR" ? "inverse" : "overlap-extension";
    const selectedPrimers = mode === "overlap-extension" ? [forward, reverse, internalReverse, internalForward] : [forward, reverse];
    const validationError = !forward || !reverse
      ? { code: "primers-required", message: "This document does not contain a selectable primer pair.", action: "Add at least a forward and reverse primer, including explicit 3′ binding lengths." }
      : selectedPrimers.some((primer) => !primer?.binding_length)
        ? { code: "binding-length-required", message: "Every selected primer needs an explicit 3′ binding length.", action: "Edit each selected primer, set its 3′ template-binding length, and choose a validated site before PCR." }
        : null;
    const executeSimulation = () => {
      if (simulationInFlightRef.current) {
        queuedSimulationRef.current = executeSimulation;
        return;
      }
      if (validationError || !forward || !reverse) {
        if (simulationTokenRef.current === token) {
          setError(validationError);
          setBusy(false);
        }
        return;
      }
      simulationInFlightRef.current = true;
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
            forwardBindingSites: forward.binding_sites,
            reverseBindingSites: reverse.binding_sites,
            internalReverseBindingSites: internalReverse?.binding_sites ?? [],
            internalForwardBindingSites: internalForward?.binding_sites ?? [],
            minimumThreePrimeMatch: 8,
            maximumMismatches: null,
            minimumOverlap: 15,
          },
        },
      }).then((next) => {
        if (simulationTokenRef.current === token) setResult(next);
      }).catch((reason: unknown) => {
        if (simulationTokenRef.current === token) setError(commandError(reason));
      }).finally(() => {
        simulationInFlightRef.current = false;
        const queued = queuedSimulationRef.current;
        queuedSimulationRef.current = null;
        if (queued) queued();
        else if (simulationTokenRef.current === token) setBusy(false);
      });
    };
    executeSimulation();
    return () => {
      if (queuedSimulationRef.current === executeSimulation) queuedSimulationRef.current = null;
      if (simulationTokenRef.current === token) simulationTokenRef.current = token + 1;
    };
  }, [active.id, active.revision, forwardIndex, internalForwardIndex, internalReverseIndex, reverseIndex, workflow]);

  const primerSelect = (label: string, value: number, onChange: (value: number) => void) => (
    <label><span>{label}</span><select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {primers.map((primer, index) => <option key={`${primer.name}-${index}`} value={index}>{primer.name} · {primer.binding_length ? `${primer.binding_length} nt 3′` : "binding not set"}</option>)}
    </select></label>
  );

  const forwardTm = result?.product.forwardBinding.meltingTemperature;
  const reverseTm = result?.product.reverseBinding.meltingTemperature;
  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="workflow-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-label={workflow}>
        <header><div><small>ACTION WORKFLOW</small><h2>{workflow}</h2><p>{explanatory}</p></div><button disabled={busy} ref={closeRef} onClick={onClose} aria-label={`Close ${workflow}`}><Icon name="close" /></button></header>
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
        <footer><span>{result ? `${result.product.features.length} deterministic product annotations` : "No product created yet"}</span><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!result || busy} onClick={() => result && onCreate(result)}>Create PCR Product</button></footer>
      </section>
    </div>
  );
}

export default function App() {
  const [documents, setDocuments] = useState<OpenDocument[]>(() => [asOpenDocument(demoDocument)]);
  const documentsRef = useRef(documents);
  const savedContentRef = useRef<Record<string, string | null>>({ [documents[0].id]: documentSavepoint(documents[0].document) });
  const [activeId, setActiveId] = useState(documents[0].id);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomView, setBottomView] = useState<BottomView>("Map Controls");
  const [selectedFeatures, setSelectedFeatures] = useState<Record<string, number | null>>({ [documents[0].id]: 4 });
  const [selectedPrimers, setSelectedPrimers] = useState<Record<string, number | null>>({});
  const [sequenceSelections, setSequenceSelections] = useState<Record<string, SequenceSelection | null>>({});
  const [findQueries, setFindQueries] = useState<Record<string, string>>({});
  const [findIndices, setFindIndices] = useState<Record<string, number>>({});
  const [findAnalyses, setFindAnalyses] = useState<Record<string, FindAnalysisState>>({});
  const [findFocusToken, setFindFocusToken] = useState(0);
  const [orfAnalyses, setOrfAnalyses] = useState<Record<string, OrfAnalysisState>>({});
  const [orfTranslations, setOrfTranslations] = useState<Record<string, OrfTranslation | null>>({});
  const [showTranslations, setShowTranslations] = useState<Record<string, boolean>>({});
  const [projectSearch, setProjectSearch] = useState("");
  const [projectFolder, setProjectFolder] = useState<ProjectFolderSummary | null>(null);
  const [projectFolderLoading, setProjectFolderLoading] = useState(false);
  const [projectFolderError, setProjectFolderError] = useState<string | null>(null);
  const [projectFolderRequestedPath, setProjectFolderRequestedPath] = useState<string | null>(null);
  const [focusedProjectFilePath, setFocusedProjectFilePath] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [monochrome, setMonochrome] = useState(false);
  const [documentZooms, setDocumentZooms] = useState<Record<string, number>>({});
  const [splitDocumentIds, setSplitDocumentIds] = useState<Set<string>>(() => new Set());
  const [splitRatios, setSplitRatios] = useState<Record<string, number>>({});
  const sequenceScrollTopsRef = useRef<Record<string, number>>({});
  const [showEnzymes, setShowEnzymes] = useState(true);
  const [showFeatureLabels, setShowFeatureLabels] = useState(true);
  const [showPrimers, setShowPrimers] = useState(true);
  const [workflow, setWorkflow] = useState<Workflow>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [annotationEditor, setAnnotationEditor] = useState<AnnotationEditorState | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null);
  const [closeRequestBusy, setCloseRequestBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [primerChecks, setPrimerChecks] = useState<PrimerCheck[]>([]);
  const [appDiagnostics, setAppDiagnostics] = useState<Diagnostic[]>([]);
  const [documentDiagnostics, setDocumentDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [editHistories, setEditHistories] = useState<Record<string, EditHistory>>({});
  const editHistoriesRef = useRef(editHistories);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const pendingEditIdsRef = useRef(pendingEditIds);
  const [pendingSaveIds, setPendingSaveIds] = useState<Set<string>>(() => new Set());
  const pendingSaveIdsRef = useRef(pendingSaveIds);
  const [draftDocumentIds, setDraftDocumentIds] = useState<Set<string>>(() => new Set());
  const draftDocumentIdsRef = useRef(draftDocumentIds);
  const menuActionRef = useRef<(id: string) => void>(() => undefined);
  const menuStateSyncRef = useRef<Promise<unknown>>(Promise.resolve());
  const openingDocumentRef = useRef(false);
  const openingFolderDialogRef = useRef(false);
  const projectFolderScanTokenRef = useRef(0);
  const projectFolderScanInFlightRef = useRef(false);
  const queuedProjectFolderScanRef = useRef<(() => void) | null>(null);
  const projectFileButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const projectFileTypeaheadRef = useRef({ query: "", at: 0 });
  const commandPaletteLauncherRef = useRef<HTMLButtonElement>(null);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const lastCommandPaletteToggleRef = useRef(0);
  const commandPaletteOpenRef = useRef(commandPaletteOpen);
  const reservedSavePathsRef = useRef<Map<string, string>>(new Map());
  const newDocumentOpenRef = useRef(newDocumentOpen);
  const workflowRef = useRef(workflow);
  const workflowBusyRef = useRef(workflowBusy);
  const annotationEditorRef = useRef(annotationEditor);
  const revealTokenRef = useRef(0);
  const orfRequestTokensRef = useRef<Record<string, number>>({});
  const orfTranslationTokensRef = useRef<Record<string, number>>({});
  const findRequestTokensRef = useRef<Record<string, number>>({});
  const findInFlightRef = useRef<Set<string>>(new Set());
  const findQueuedRunsRef = useRef<Record<string, (() => void) | undefined>>({});
  const primerCheckTokenRef = useRef(0);
  const primerCheckInFlightRef = useRef(false);
  const primerCheckQueuedRunRef = useRef<(() => void) | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  newDocumentOpenRef.current = newDocumentOpen;
  workflowRef.current = workflow;
  workflowBusyRef.current = workflowBusy;
  annotationEditorRef.current = annotationEditor;
  commandPaletteOpenRef.current = commandPaletteOpen;

  const active = documents.find((document) => document.id === activeId) ?? null;
  const annotationDocument = annotationEditor ? documents.find((document) => document.id === annotationEditor.documentId) ?? null : null;
  const selectedFeature = active ? selectedFeatures[active.id] ?? null : null;
  const selectedPrimer = active ? selectedPrimers[active.id] ?? null : null;
  const storedSelection = active ? sequenceSelections[active.id] ?? null : null;
  const activeSelection = active && storedSelection?.revision === active.revision ? storedSelection : null;
  const activeBusy = active ? pendingEditIds.has(active.id) || pendingSaveIds.has(active.id) : false;
  const splitActive = active ? splitDocumentIds.has(active.id) : false;
  const splitRatio = active ? splitRatios[active.id] ?? 44 : 44;
  const zoom = active ? documentZooms[active.id] ?? 1 : 1;
  const activeCanSave = canSaveDocument(active, activeBusy);
  const canUndo = active ? !activeBusy && (editHistories[active.id]?.undo.length ?? 0) > 0 : false;
  const canRedo = active ? !activeBusy && (editHistories[active.id]?.redo.length ?? 0) > 0 : false;
  const blockingModalOpen = newDocumentOpen || workflow !== null || annotationEditor !== null || closeRequest !== null;
  const commandEligibility = nativeMenuState({
    hasActiveDocument: active !== null,
    activeBusy,
    activeCanSave,
    canUndo,
    canRedo,
    hasDraft: draftDocumentIds.size > 0,
    modalOpen: blockingModalOpen,
    closeBusy: closeRequestBusy,
    activeView: active?.view ?? null,
  });
  const nativeMenu = commandPaletteOpen ? nativeMenuState({
    hasActiveDocument: active !== null,
    activeBusy,
    activeCanSave,
    canUndo,
    canRedo,
    hasDraft: draftDocumentIds.size > 0,
    modalOpen: true,
    closeBusy: closeRequestBusy,
    activeView: active?.view ?? null,
  }) : commandEligibility;
  const filteredDocuments = useMemo(() => documents.filter((document) => document.document.name.toLowerCase().includes(projectSearch.toLowerCase())), [documents, projectSearch]);
  const filteredProjectFiles = useMemo(() => projectFolder?.files.filter((file) => `${file.name} ${file.relativePath} ${file.format}`.toLowerCase().includes(projectSearch.toLowerCase())) ?? [], [projectFolder, projectSearch]);
  const activeProjectFileVisible = useMemo(() => filteredProjectFiles.some((file) => file.path === active?.path), [active?.path, filteredProjectFiles]);
  const focusedProjectFileVisible = useMemo(() => filteredProjectFiles.some((file) => file.path === focusedProjectFilePath), [filteredProjectFiles, focusedProjectFilePath]);

  useEffect(() => {
    setFocusedProjectFilePath((current) => {
      if (!filteredProjectFiles.length) return null;
      if (current && filteredProjectFiles.some((file) => file.path === current)) return current;
      return activeProjectFileVisible && active?.path ? active.path : filteredProjectFiles[0].path;
    });
  }, [active?.path, activeProjectFileVisible, filteredProjectFiles]);

  useEffect(() => {
    if (!actionsOpen) return;
    if (!commandEligibility.molecularActions) {
      setActionsOpen(false);
      return;
    }
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActionsOpen(false);
      window.requestAnimationFrame(() => actionsButtonRef.current?.focus());
    };
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || actionsMenuRef.current?.contains(target) || actionsButtonRef.current?.contains(target)) return;
      setActionsOpen(false);
    };
    document.addEventListener("keydown", closeFromEscape);
    document.addEventListener("pointerdown", closeFromOutside);
    return () => {
      document.removeEventListener("keydown", closeFromEscape);
      document.removeEventListener("pointerdown", closeFromOutside);
    };
  }, [actionsOpen, commandEligibility.molecularActions]);
  const restrictionScan = useMemo(() => active ? scanRestrictionSites(active.document.sequence, active.document.topology === "circular") : { sites: [], truncated: false, truncatedEnzymes: [] }, [active?.document.sequence, active?.document.topology]);
  const restrictionSites = restrictionScan.sites;
  const restrictionCounts = useMemo(() => restrictionSiteCounts(restrictionSites), [restrictionSites]);
  const findQuery = active ? findQueries[active.id] ?? "" : "";
  const findValidation = useMemo(() => validateFindQuery(findQuery), [findQuery]);
  const activeFindAnalysis = active ? findAnalyses[active.id] ?? null : null;
  const visibleFindAnalysis = active && activeFindAnalysis?.revision === active.revision && activeFindAnalysis.query === findQuery ? activeFindAnalysis : null;
  const findMatches = visibleFindAnalysis?.matches ?? [];
  const findIndex = active ? Math.min(findIndices[active.id] ?? 0, Math.max(findMatches.length - 1, 0)) : 0;
  const secondaryFindIntervals = useMemo(() => findMatches.flatMap((match) => match.intervals), [findMatches]);
  const activeOrfState = active ? orfAnalyses[active.id] ?? null : null;
  const selectedOrf = activeSelection?.source === "orf" && active && activeOrfState && activeOrfState.revision === active.revision
    ? activeOrfState.items.find((orf) => orf.id === activeSelection.entityId.replace(/^orf:/, "")) ?? null
    : null;
  const storedTranslation = active ? orfTranslations[active.id] ?? null : null;
  const activeTranslation = active && showTranslations[active.id] && selectedOrf && storedTranslation?.orfId === selectedOrf.id ? storedTranslation : null;

  function setZoom(value: number) {
    if (!active) return;
    setDocumentZooms((current) => ({ ...current, [active.id]: value }));
  }

  function revealSelection(document: OpenDocument, selection: Omit<SequenceSelection, "documentId" | "revision" | "revealToken">) {
    if (selection.source !== "find") {
      findRequestTokensRef.current[document.id] = (findRequestTokensRef.current[document.id] ?? 0) + 1;
    }
    if (selection.source !== "orf") {
      orfTranslationTokensRef.current[document.id] = (orfTranslationTokensRef.current[document.id] ?? 0) + 1;
      setOrfTranslations((current) => ({ ...current, [document.id]: null }));
    }
    const nextSelection: SequenceSelection = {
      ...selection,
      documentId: document.id,
      revision: document.revision,
      revealToken: ++revealTokenRef.current,
    };
    setSequenceSelections((current) => ({ ...current, [document.id]: nextSelection }));
    if (!splitDocumentIds.has(document.id)) {
      updateDocuments((current) => current.map((item) => item.id === document.id ? { ...item, view: "sequence" } : item));
    }
    setActiveId(document.id);
    return nextSelection;
  }

  function revealFeature(document: OpenDocument, index: number) {
    const feature = document.document.features[index];
    if (!feature) return;
    const intervals = normalizeIntervals(feature.segments.map((segment) => segment.span), document.length);
    setSelectedFeatures((current) => ({ ...current, [document.id]: index }));
    setSelectedPrimers((current) => ({ ...current, [document.id]: null }));
    const selection = revealSelection(document, {
      source: "feature",
      entityId: `feature:${feature.id ?? `${index}:${feature.name}`}`,
      label: feature.name,
      intervals,
      strand: feature.strand,
      wrapsOrigin: document.document.topology === "circular" && intervals.some(({ start }) => start === 0) && intervals.some(({ end }) => end === document.length),
      color: feature.color,
      detail: `${feature.kind} · ${intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0).toLocaleString()} bp`,
    });
    setStatus(`Selected ${feature.name} · ${displayIntervals(selection.intervals)} · ${feature.strand}`);
  }

  function selectFeature(index: number) {
    if (active) revealFeature(active, index);
  }

  function selectFeatureRow(index: number) {
    if (!active || !active.document.features[index]) return;
    setSelectedFeatures((current) => ({ ...current, [active.id]: index }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    setSequenceSelections((current) => ({ ...current, [active.id]: null }));
    setOrfTranslations((current) => ({ ...current, [active.id]: null }));
    setStatus(`Selected ${active.document.features[index].name} · double-click or choose Edit Selected to edit`);
  }

  function revealPrimer(document: OpenDocument, index: number) {
    const primer = document.document.primers[index];
    if (!primer) return;
    setSelectedPrimers((current) => ({ ...current, [document.id]: index }));
    setSelectedFeatures((current) => ({ ...current, [document.id]: null }));
    const intervals = normalizeIntervals(primer.binding_sites.map((site) => site.span), document.length);
    if (!intervals.length) {
      setStatus(`${primer.name} has no stored binding site · choose Edit Selected to validate and attach one`);
      return;
    }
    const strands = new Set(primer.binding_sites.map((site) => site.strand));
    const strand = strands.size === 1 ? primer.binding_sites[0].strand : "both";
    const selection = revealSelection(document, {
      source: "primer",
      entityId: `primer:${primer.id ?? `${index}:${primer.name}`}`,
      label: primer.name,
      intervals,
      strand,
      wrapsOrigin: document.document.topology === "circular" && intervals.some(({ start }) => start === 0) && intervals.some(({ end }) => end === document.length),
      color: primer.color,
      detail: `${primer.binding_length ?? primer.sequence.length} nt 3′ binding · ${Math.max(0, primer.sequence.length - (primer.binding_length ?? primer.sequence.length))} nt 5′ tail`,
    });
    setStatus(`Selected primer ${primer.name} · ${displayIntervals(selection.intervals)}`);
  }

  function selectPrimer(index: number) {
    if (active) revealPrimer(active, index);
  }

  function selectPrimerRow(index: number) {
    if (!active || !active.document.primers[index]) return;
    setSelectedPrimers((current) => ({ ...current, [active.id]: index }));
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSequenceSelections((current) => ({ ...current, [active.id]: null }));
    setOrfTranslations((current) => ({ ...current, [active.id]: null }));
    setStatus(`Selected ${active.document.primers[index].name} · double-click or choose Edit Selected to edit`);
  }

  function selectRestrictionSite(site: RestrictionSite) {
    if (!active) return;
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    const selection = revealSelection(active, {
      source: "restriction",
      entityId: `restriction:${site.enzyme}:${site.position}:${site.orientation}`,
      label: `${site.enzyme} · ${site.recognitionSequence}`,
      intervals: site.intervals,
      strand: site.orientation,
      wrapsOrigin: site.wrapsOrigin,
      detail: `${site.orientation} recognition site · cut boundaries shown in gold`,
      cutPositions: { top: site.topCutPosition, bottom: site.bottomCutPosition },
    });
    setStatus(`${site.enzyme} site at ${displayIntervals(selection.intervals)} · top ${cutBoundaryLabel(site.topCutPosition)}, bottom ${cutBoundaryLabel(site.bottomCutPosition)}`);
  }

  function selectFindMatch(index: number, matches = findMatches, query = findQuery) {
    if (!active || !matches.length) return;
    const normalizedIndex = ((index % matches.length) + matches.length) % matches.length;
    const match = matches[normalizedIndex];
    setFindIndices((current) => ({ ...current, [active.id]: normalizedIndex }));
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    revealSelection(active, {
      source: "find",
      entityId: `find:${query.toUpperCase()}:${match.start}`,
      label: `Find “${query}”`,
      intervals: match.intervals,
      strand: match.strand,
      wrapsOrigin: match.wrapsOrigin,
      detail: `Match ${normalizedIndex + 1} of ${matches.length}${visibleFindAnalysis?.capped ? "+" : ""} · ${match.strand} strand`,
    });
    setStatus(`Find match ${normalizedIndex + 1} of ${matches.length}${visibleFindAnalysis?.capped ? "+" : ""} · ${match.strand} strand · ${displayIntervals(match.intervals)}`);
  }

  function changeFindQuery(query: string) {
    if (!active) return;
    setFindQueries((current) => ({ ...current, [active.id]: query }));
    setFindIndices((current) => ({ ...current, [active.id]: 0 }));
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    setSequenceSelections((current) => ({ ...current, [active.id]: null }));
    orfTranslationTokensRef.current[active.id] = (orfTranslationTokensRef.current[active.id] ?? 0) + 1;
    setOrfTranslations((current) => ({ ...current, [active.id]: null }));
    const validation = validateFindQuery(query);
    setStatus(validation.error ?? (query ? `Searching both strands for “${query}”…` : "Find sequence"));
  }

  function moveFind(direction: 1 | -1) {
    if (!findMatches.length) return;
    const next = (findIndex + direction + findMatches.length) % findMatches.length;
    selectFindMatch(next);
  }

  function openFind() {
    if (!active) return;
    setActiveView("sequence");
    setBottomOpen(true);
    setBottomView("Find");
    setFindFocusToken((token) => token + 1);
    if (findMatches.length) selectFindMatch(findIndex);
  }

  async function analyzeOrfs(document: OpenDocument, minimumAminoAcids: number, force = false) {
    const existing = orfAnalyses[document.id];
    if (!force && existing?.revision === document.revision && existing.minimumAminoAcids === minimumAminoAcids) return;
    const requestToken = (orfRequestTokensRef.current[document.id] ?? 0) + 1;
    orfRequestTokensRef.current[document.id] = requestToken;
    if (force) {
      setSequenceSelections((current) => current[document.id]?.source === "orf" ? { ...current, [document.id]: null } : current);
      orfTranslationTokensRef.current[document.id] = (orfTranslationTokensRef.current[document.id] ?? 0) + 1;
      setOrfTranslations((current) => ({ ...current, [document.id]: null }));
    }
    setOrfAnalyses((current) => ({ ...current, [document.id]: { revision: document.revision, minimumAminoAcids, loading: true, error: null, truncated: false, items: [] } }));
    try {
      const result = await invoke<OrfAnalysisResponse>("analyze_open_reading_frames", { request: { sequence: document.document.sequence, circular: document.document.topology === "circular", minimumAminoAcids } });
      const items = result.orfs;
      const live = documentsRef.current.find((item) => item.id === document.id);
      if (!live || live.revision !== document.revision || orfRequestTokensRef.current[document.id] !== requestToken) return;
      setOrfAnalyses((current) => ({ ...current, [document.id]: { revision: document.revision, minimumAminoAcids, loading: false, error: null, truncated: result.truncated, items } }));
      setStatus(`Found ${items.length.toLocaleString()}${result.truncated ? "+" : ""} complete ORFs across six reading frames`);
    } catch (error) {
      const live = documentsRef.current.find((item) => item.id === document.id);
      if (!live || live.revision !== document.revision || orfRequestTokensRef.current[document.id] !== requestToken) return;
      setOrfAnalyses((current) => ({ ...current, [document.id]: { revision: document.revision, minimumAminoAcids, loading: false, error: String(error), truncated: false, items: [] } }));
      setStatus(`ORF analysis failed: ${String(error)}`);
    }
  }

  function openOrfs() {
    if (!active) return;
    if (pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) {
      setStatus("Wait for the current edit or save before analyzing ORFs");
      return;
    }
    setActiveView("sequence");
    setBottomOpen(true);
    setBottomView("ORFs");
    setShowTranslations((current) => ({ ...current, [active.id]: current[active.id] ?? true }));
    void analyzeOrfs(active, activeOrfState?.minimumAminoAcids ?? 20);
  }

  async function loadOrfTranslation(document: OpenDocument, orf: OpenReadingFrame) {
    const requestToken = (orfTranslationTokensRef.current[document.id] ?? 0) + 1;
    orfTranslationTokensRef.current[document.id] = requestToken;
    setOrfTranslations((current) => ({ ...current, [document.id]: null }));
    setStatus(`Translating ORF frame ${orf.frame > 0 ? `+${orf.frame}` : orf.frame}…`);
    try {
      const translation = await invoke<OrfTranslation>("translate_selected_open_reading_frame", { request: { sequence: document.document.sequence, circular: document.document.topology === "circular", orf } });
      const live = documentsRef.current.find((item) => item.id === document.id);
      if (!live || live.revision !== document.revision || orfTranslationTokensRef.current[document.id] !== requestToken) return;
      setOrfTranslations((current) => ({ ...current, [document.id]: translation }));
      setStatus(`Translated ORF frame ${orf.frame > 0 ? `+${orf.frame}` : orf.frame} · ${orf.aminoAcidLength.toLocaleString()} aa`);
    } catch (error) {
      const live = documentsRef.current.find((item) => item.id === document.id);
      if (!live || live.revision !== document.revision || orfTranslationTokensRef.current[document.id] !== requestToken) return;
      setStatus(`ORF translation unavailable: ${String(error)}`);
      setDocumentDiagnostics((current) => ({ ...current, [document.id]: [...(current[document.id] ?? []), { level: "warn", title: "Translation track unavailable", body: String(error) }] }));
    }
  }

  function selectOrf(orf: OpenReadingFrame) {
    if (!active) return;
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    setShowTranslations((current) => ({ ...current, [active.id]: true }));
    revealSelection(active, {
      source: "orf",
      entityId: `orf:${orf.id}`,
      label: `ORF frame ${orf.frame > 0 ? `+${orf.frame}` : orf.frame}`,
      intervals: orf.intervals,
      strand: orf.strand,
      wrapsOrigin: orf.wrapsOrigin,
      detail: `${orf.aminoAcidLength.toLocaleString()} aa · complete start-to-stop ORF`,
    });
    void loadOrfTranslation(active, orf);
  }

  function setBottomPanelView(view: BottomView) {
    if (view === "Find") openFind();
    else if (view === "ORFs") openOrfs();
    else setBottomView(view);
  }

  function updateDocuments(update: (current: OpenDocument[]) => OpenDocument[]) {
    const next = update(documentsRef.current);
    documentsRef.current = next;
    setDocuments(next);
  }

  function invalidateDerivedState(documentId: string) {
    orfRequestTokensRef.current[documentId] = (orfRequestTokensRef.current[documentId] ?? 0) + 1;
    orfTranslationTokensRef.current[documentId] = (orfTranslationTokensRef.current[documentId] ?? 0) + 1;
    findRequestTokensRef.current[documentId] = (findRequestTokensRef.current[documentId] ?? 0) + 1;
    setSequenceSelections((current) => ({ ...current, [documentId]: null }));
    setOrfAnalyses((current) => {
      const updated = { ...current };
      delete updated[documentId];
      return updated;
    });
    setOrfTranslations((current) => ({ ...current, [documentId]: null }));
    setFindAnalyses((current) => { const updated = { ...current }; delete updated[documentId]; return updated; });
  }

  function setPending(setter: (value: Set<string>) => void, reference: { current: Set<string> }, id: string, pending: boolean) {
    const next = new Set(reference.current);
    if (pending) next.add(id);
    else next.delete(id);
    reference.current = next;
    setter(next);
  }

  function matchesSavepoint(id: string, document: SequenceDocument) {
    return matchesDocumentSavepoint(savedContentRef.current[id], document);
  }

  function setDocumentDraftState(id: string, dirty: boolean) {
    const next = new Set(draftDocumentIdsRef.current);
    if (dirty) next.add(id);
    else next.delete(id);
    draftDocumentIdsRef.current = next;
    setDraftDocumentIds(next);
  }

  function focusDocumentDraft(id: string) {
    setActiveId(id);
    if (annotationEditorRef.current?.documentId === id) {
      setStatus("Apply or cancel the annotation draft before continuing.");
      return;
    }
    updateDocuments((current) => current.map((document) => document.id === id ? { ...document, view: "sequence" } : document));
    setStatus("Apply or cancel the sequence draft before continuing.");
  }

  function activateDocument(id: string) {
    const blockingDraft = [...draftDocumentIdsRef.current].find((draftId) => draftId !== id);
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    setActiveId(id);
  }

  function beginNewDocument() {
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    setNewDocumentOpen(true);
  }

  useEffect(() => {
    if (!active) return;
    const document = active;
    const validation = validateFindQuery(findQuery);
    const requestToken = (findRequestTokensRef.current[document.id] ?? 0) + 1;
    findRequestTokensRef.current[document.id] = requestToken;
    if (!validation.query || validation.error) {
      setFindAnalyses((current) => ({
        ...current,
        [document.id]: { revision: document.revision, query: findQuery, loading: false, error: validation.error, capped: false, matches: [] },
      }));
      return;
    }
    setFindAnalyses((current) => ({
      ...current,
      [document.id]: { revision: document.revision, query: findQuery, loading: true, error: null, capped: false, matches: [] },
    }));
    const executeSearch = () => {
      if (findRequestTokensRef.current[document.id] !== requestToken) return;
      if (findInFlightRef.current.has(document.id)) {
        findQueuedRunsRef.current[document.id] = executeSearch;
        return;
      }
      findInFlightRef.current.add(document.id);
      void invoke<SequenceMatch[]>("find_sequence", {
        request: {
          sequence: document.document.sequence,
          query: validation.query,
          circular: document.document.topology === "circular",
          maximumResults: MAX_FIND_MATCHES + 1,
        },
      }).then((results) => {
        const live = documentsRef.current.find((item) => item.id === document.id);
        if (!live || live.revision !== document.revision || findRequestTokensRef.current[document.id] !== requestToken) return;
        const capped = results.length > MAX_FIND_MATCHES;
        const matches = results.slice(0, MAX_FIND_MATCHES);
        setFindAnalyses((current) => ({ ...current, [document.id]: { revision: document.revision, query: findQuery, loading: false, error: null, capped, matches } }));
        setFindIndices((current) => ({ ...current, [document.id]: 0 }));
        if (matches.length) {
          const match = matches[0];
          setSelectedFeatures((current) => ({ ...current, [document.id]: null }));
          setSelectedPrimers((current) => ({ ...current, [document.id]: null }));
          setSequenceSelections((current) => ({ ...current, [document.id]: {
            documentId: document.id,
            revision: document.revision,
            source: "find",
            entityId: `find:${validation.query}:${match.start}:${match.strand}`,
            label: `Find “${findQuery}”`,
            intervals: match.intervals,
            strand: match.strand,
            wrapsOrigin: match.wrapsOrigin,
            revealToken: ++revealTokenRef.current,
            detail: `Match 1 of ${matches.length}${capped ? "+" : ""} · ${match.strand} strand`,
          } }));
          setStatus(`Find match 1 of ${matches.length}${capped ? "+" : ""} · ${match.strand} strand · ${displayIntervals(match.intervals)}`);
        } else {
          setSequenceSelections((current) => current[document.id]?.source === "find" ? { ...current, [document.id]: null } : current);
          setStatus(`No matches for “${findQuery}” on either strand`);
        }
      }).catch((error: unknown) => {
        const live = documentsRef.current.find((item) => item.id === document.id);
        if (!live || live.revision !== document.revision || findRequestTokensRef.current[document.id] !== requestToken) return;
        setFindAnalyses((current) => ({ ...current, [document.id]: { revision: document.revision, query: findQuery, loading: false, error: String(error), capped: false, matches: [] } }));
        setStatus(`Sequence search failed: ${String(error)}`);
      }).finally(() => {
        findInFlightRef.current.delete(document.id);
        const queued = findQueuedRunsRef.current[document.id];
        delete findQueuedRunsRef.current[document.id];
        queued?.();
      });
    };
    const timeout = window.setTimeout(executeSearch, 140);
    return () => {
      window.clearTimeout(timeout);
      if (findQueuedRunsRef.current[document.id] === executeSearch) delete findQueuedRunsRef.current[document.id];
      if (findRequestTokensRef.current[document.id] === requestToken) findRequestTokensRef.current[document.id] = requestToken + 1;
    };
  }, [active?.document.sequence, active?.document.topology, active?.id, active?.revision, findQuery]);

  useEffect(() => {
    const document = active;
    const token = ++primerCheckTokenRef.current;
    if (!document?.document.primers.length) {
      setPrimerChecks([]);
      return;
    }
    setPrimerChecks([]);
    const executeAnalysis = () => {
      if (primerCheckInFlightRef.current) {
        primerCheckQueuedRunRef.current = executeAnalysis;
        return;
      }
      primerCheckInFlightRef.current = true;
      void invoke<PrimerCheck[]>("analyze_document_primers", {
        request: {
          templateSequence: document.document.sequence,
          circular: document.document.topology === "circular",
          primers: document.document.primers.map((primer) => ({ name: primer.name, sequence: primer.sequence, bindingLength: primer.binding_length })),
        },
      }).then((checks) => {
        if (primerCheckTokenRef.current === token) setPrimerChecks(checks);
      }).catch((error: unknown) => {
        if (primerCheckTokenRef.current === token) setAppDiagnostics((current) => [...current, { level: "error", title: "Primer checks could not run", body: String(error) }]);
      }).finally(() => {
        primerCheckInFlightRef.current = false;
        const queued = primerCheckQueuedRunRef.current;
        primerCheckQueuedRunRef.current = null;
        queued?.();
      });
    };
    executeAnalysis();
    return () => {
      if (primerCheckQueuedRunRef.current === executeAnalysis) primerCheckQueuedRunRef.current = null;
      if (primerCheckTokenRef.current === token) primerCheckTokenRef.current = token + 1;
    };
  }, [active?.id, active?.revision]);

  function setActiveView(view: DocumentView) {
    if (!active) return;
    if (draftDocumentIdsRef.current.has(active.id) && view !== "sequence") {
      focusDocumentDraft(active.id);
      return;
    }
    if (active.view === view) return;
    if (view !== "map" && view !== "sequence") {
      setSplitDocumentIds((current) => {
        const next = new Set(current);
        next.delete(active.id);
        return next;
      });
    }
    updateDocuments((current) => current.map((document) => document.id === active.id ? { ...document, view } : document));
  }

  function toggleSplit() {
    if (!active) return;
    if (draftDocumentIdsRef.current.has(active.id)) {
      focusDocumentDraft(active.id);
      return;
    }
    setSplitDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(active.id)) next.delete(active.id);
      else next.add(active.id);
      return next;
    });
    if (active.view !== "map" && active.view !== "sequence") {
      updateDocuments((current) => current.map((document) => document.id === active.id ? { ...document, view: "sequence" } : document));
    }
    setStatus(splitActive ? "Closed Map/Sequence Split" : "Opened synchronized Map/Sequence Split");
  }

  function openFeatureEditor(index: number | null = null) {
    if (!active || pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) return;
    if (draftDocumentIdsRef.current.has(active.id)) {
      focusDocumentDraft(active.id);
      return;
    }
    if (index !== null && !active.document.features[index]) return;
    setAnnotationEditor({ kind: "feature", documentId: active.id, revision: active.revision, index });
  }

  function openPrimerEditor(index: number | null = null) {
    if (!active || pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) return;
    if (draftDocumentIdsRef.current.has(active.id)) {
      focusDocumentDraft(active.id);
      return;
    }
    if (index !== null && !active.document.primers[index]) return;
    setAnnotationEditor({ kind: "primer", documentId: active.id, revision: active.revision, index });
  }

  function closeAnnotationEditor() {
    if (annotationEditor) setDocumentDraftState(annotationEditor.documentId, false);
    setAnnotationEditor(null);
  }

  function requestCloseAnnotationEditor() {
    if (!annotationEditor) return;
    if (pendingEditIdsRef.current.has(annotationEditor.documentId)) {
      setStatus("Wait for the annotation change to finish before closing the sheet");
      return;
    }
    if (draftDocumentIdsRef.current.has(annotationEditor.documentId) && !window.confirm("Discard the unapplied annotation changes?")) return;
    closeAnnotationEditor();
  }

  async function commitDocumentMutation(documentId: string, revision: number, mutation: DocumentMutation, statusLabel: string) {
    if (pendingEditIdsRef.current.has(documentId) || pendingSaveIdsRef.current.has(documentId)) throw new Error("Wait for the current edit or save to finish.");
    const editingDocument = documentsRef.current.find((document) => document.id === documentId);
    if (!editingDocument || editingDocument.revision !== revision) throw new Error("The document changed while the editor was open. Reopen the sheet and try again.");
    setPending(setPendingEditIds, pendingEditIdsRef, documentId, true);
    setStatus(`${statusLabel}…`);
    try {
      const result = await invoke<DocumentMutationResult>("apply_document_mutation", { request: { document: editingDocument.document, mutation } });
      const live = documentsRef.current.find((document) => document.id === documentId);
      if (!live || live.revision !== revision) throw new Error("The document changed while this annotation edit was running; the stale result was discarded.");
      if (!result.changed) {
        closeAnnotationEditor();
        setStatus("No annotation changes to apply");
        return { result, document: live };
      }
      const history = editHistoriesRef.current[documentId] ?? { undo: [], redo: [] };
      const nextHistories = { ...editHistoriesRef.current, [documentId]: { undo: appendHistorySnapshot(history.undo, editingDocument), redo: [] } };
      editHistoriesRef.current = nextHistories;
      setEditHistories(nextHistories);
      invalidateDerivedState(documentId);
      const nextDocument: OpenDocument = {
        ...editingDocument,
        document: result.summary.document,
        length: result.summary.length,
        gcPercent: result.summary.gcPercent,
        unknownBases: result.summary.unknownBases,
        diagnostics: result.summary.diagnostics,
        dirty: !matchesSavepoint(documentId, result.summary.document),
        revision: editingDocument.revision + 1,
      };
      updateDocuments((current) => current.map((document) => document.id === documentId && document.revision === revision ? nextDocument : document));
      closeAnnotationEditor();
      setStatus(statusLabel.replace(/ing\b/, "ed"));
      return { result, document: nextDocument };
    } finally {
      setPending(setPendingEditIds, pendingEditIdsRef, documentId, false);
    }
  }

  async function saveFeatureAnnotation(feature: Feature) {
    if (!annotationEditor || annotationEditor.kind !== "feature" || !annotationDocument) return;
    const index = annotationEditor.index;
    const mutation: DocumentMutation = index === null
      ? { kind: "create-feature", feature }
      : { kind: "replace-feature", index, expected: annotationDocument.document.features[index], replacement: feature };
    const committed = await commitDocumentMutation(annotationEditor.documentId, annotationEditor.revision, mutation, index === null ? `Adding feature ${feature.name}` : `Updating feature ${feature.name}`);
    if (committed?.result.entityIndex !== null) revealFeature(committed.document, committed.result.entityIndex);
  }

  async function deleteFeatureAnnotation() {
    if (!annotationEditor || annotationEditor.kind !== "feature" || annotationEditor.index === null || !annotationDocument) return;
    const index = annotationEditor.index;
    const feature = annotationDocument.document.features[index];
    await commitDocumentMutation(annotationEditor.documentId, annotationEditor.revision, { kind: "delete-feature", index, expected: feature }, `Removing feature ${feature.name}`);
    setSelectedFeatures((current) => ({ ...current, [annotationEditor.documentId]: null }));
  }

  async function savePrimerAnnotation(primer: Primer) {
    if (!annotationEditor || annotationEditor.kind !== "primer" || !annotationDocument) return;
    const index = annotationEditor.index;
    const mutation: DocumentMutation = index === null
      ? { kind: "create-primer", primer }
      : { kind: "replace-primer", index, expected: annotationDocument.document.primers[index], replacement: primer };
    const committed = await commitDocumentMutation(annotationEditor.documentId, annotationEditor.revision, mutation, index === null ? `Adding primer ${primer.name}` : `Updating primer ${primer.name}`);
    const entityIndex = committed?.result.entityIndex;
    if (entityIndex === null || entityIndex === undefined) return;
    setSelectedPrimers((current) => ({ ...current, [annotationEditor.documentId]: entityIndex }));
    if (committed.document.document.primers[entityIndex]?.binding_sites.length) revealPrimer(committed.document, entityIndex);
    else setStatus(`Saved ${primer.name} without a stored binding site`);
  }

  async function deletePrimerAnnotation() {
    if (!annotationEditor || annotationEditor.kind !== "primer" || annotationEditor.index === null || !annotationDocument) return;
    const index = annotationEditor.index;
    const primer = annotationDocument.document.primers[index];
    await commitDocumentMutation(annotationEditor.documentId, annotationEditor.revision, { kind: "delete-primer", index, expected: primer }, `Removing primer ${primer.name}`);
    setSelectedPrimers((current) => ({ ...current, [annotationEditor.documentId]: null }));
  }

  async function loadDocumentPath(path: string) {
    setStatus(`Opening ${path.split("/").at(-1)}…`);
    const summary = await invoke<DocumentSummary>("open_document", { path });
    const alreadyOpen = findOpenDocumentByPath(documentsRef.current, summary.path);
    if (alreadyOpen) {
      setActiveId(alreadyOpen.id);
      setStatus(`${summary.document.name} is already open`);
      return;
    }
    const opened = asOpenDocument(summary);
    savedContentRef.current[opened.id] = documentSavepoint(opened.document);
    updateDocuments((current) => [...current, opened]);
    setActiveId(opened.id);
    setSelectedFeatures((current) => ({ ...current, [opened.id]: opened.document.features.length ? 0 : null }));
    setAppDiagnostics([]);
    setStatus(`Opened ${summary.document.name}`);
  }

  async function openDocumentPath(path: string) {
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    if (openingDocumentRef.current) return;
    openingDocumentRef.current = true;
    try {
      await loadDocumentPath(path);
    } catch (error) {
      setStatus(`Could not open document: ${String(error)}`);
      setAppDiagnostics([{ level: "error", title: "Document could not be opened", body: `${String(error)} Check the file format and try again.` }]);
      setBottomView("Warnings");
      setBottomOpen(true);
    } finally {
      openingDocumentRef.current = false;
    }
  }

  async function openFile() {
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    if (openingDocumentRef.current) return;
    openingDocumentRef.current = true;
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "DNA documents", extensions: ["dna", "dotdna", "gb", "gbk", "genbank", "fa", "fas", "fasta", "fna", "json", "txt"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      await loadDocumentPath(path);
    } catch (error) {
      setStatus(`Could not open document: ${String(error)}`);
      setAppDiagnostics([{ level: "error", title: "Document could not be opened", body: `${String(error)} Check the file format and try again.` }]);
      setBottomView("Warnings");
      setBottomOpen(true);
    } finally {
      openingDocumentRef.current = false;
    }
  }

  function scanProjectFolder(path: string) {
    const token = ++projectFolderScanTokenRef.current;
    setProjectFolderRequestedPath(path);
    setProjectFolderLoading(true);
    setProjectFolderError(null);
    setStatus(`Scanning ${path.split("/").filter(Boolean).at(-1) ?? "project folder"}…`);
    const execute = () => {
      if (projectFolderScanTokenRef.current !== token) return;
      if (projectFolderScanInFlightRef.current) {
        queuedProjectFolderScanRef.current = execute;
        return;
      }
      projectFolderScanInFlightRef.current = true;
      void invoke<ProjectFolderSummary>("scan_project_folder", { path }).then((summary) => {
        if (projectFolderScanTokenRef.current !== token) return;
        setProjectFolder(summary);
        setStatus(`Opened project folder ${summary.name} · ${summary.files.length.toLocaleString()} DNA file${summary.files.length === 1 ? "" : "s"}${summary.truncated ? "+" : ""}`);
      }).catch((error: unknown) => {
        if (projectFolderScanTokenRef.current !== token) return;
        setProjectFolderError(String(error));
        setStatus(`Could not open project folder: ${String(error)}`);
      }).finally(() => {
        projectFolderScanInFlightRef.current = false;
        if (projectFolderScanTokenRef.current === token) setProjectFolderLoading(false);
        const queued = queuedProjectFolderScanRef.current;
        queuedProjectFolderScanRef.current = null;
        queued?.();
      });
    };
    execute();
  }

  async function openProjectFolder() {
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    if (openingFolderDialogRef.current) return;
    openingFolderDialogRef.current = true;
    let path: string | null = null;
    try {
      const selected = await open({ directory: true, multiple: false, title: "Open DOTDNA Project Folder" });
      path = Array.isArray(selected) ? selected[0] ?? null : selected;
    } finally {
      openingFolderDialogRef.current = false;
    }
    if (path) scanProjectFolder(path);
  }

  function closeProjectFolder() {
    projectFolderScanTokenRef.current += 1;
    queuedProjectFolderScanRef.current = null;
    setProjectFolder(null);
    setProjectFolderLoading(false);
    setProjectFolderError(null);
    setProjectFolderRequestedPath(null);
    setStatus("Closed project folder · open documents were preserved");
  }

  function closeDocument(id: string) {
    if (pendingEditIdsRef.current.has(id) || pendingSaveIdsRef.current.has(id)) {
      setStatus("Wait for the current edit or save to finish before closing this document.");
      return;
    }
    if (draftDocumentIdsRef.current.has(id)) {
      focusDocumentDraft(id);
      return;
    }
    const currentDocuments = documentsRef.current;
    const closing = currentDocuments.find((document) => document.id === id);
    if (closing?.dirty) {
      setCloseRequest({ kind: "document", id });
      return;
    }
    removeDocument(id);
  }

  function removeDocument(id: string) {
    const currentDocuments = documentsRef.current;
    const index = currentDocuments.findIndex((document) => document.id === id);
    if (index < 0) return;
    const next = currentDocuments.filter((document) => document.id !== id);
    documentsRef.current = next;
    setDocuments(next);
    setSelectedFeatures((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    setSelectedPrimers((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setSplitDocumentIds((current) => { const updated = new Set(current); updated.delete(id); return updated; });
    setSplitRatios((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    delete sequenceScrollTopsRef.current[id];
    setDocumentZooms((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setSequenceSelections((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    setFindQueries((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setFindIndices((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setFindAnalyses((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setOrfAnalyses((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setOrfTranslations((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    setShowTranslations((current) => { const updated = { ...current }; delete updated[id]; return updated; });
    delete orfRequestTokensRef.current[id];
    delete orfTranslationTokensRef.current[id];
    delete findRequestTokensRef.current[id];
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
    delete savedContentRef.current[id];
    setDocumentDraftState(id, false);
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
    invalidateDerivedState(active.id);
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    updateDocuments((current) => current.map((document) => document.id === active.id ? {
      ...previous,
      path: active.path,
      format: active.format,
      fileVersion: active.fileVersion,
      dirty: !matchesSavepoint(active.id, previous.document),
      view: active.view,
      revision: active.revision + 1,
    } : document));
    setStatus(`Undid document edit · ${previous.length.toLocaleString()} bp`);
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
    invalidateDerivedState(active.id);
    setSelectedFeatures((current) => ({ ...current, [active.id]: null }));
    setSelectedPrimers((current) => ({ ...current, [active.id]: null }));
    updateDocuments((current) => current.map((document) => document.id === active.id ? {
      ...next,
      path: active.path,
      format: active.format,
      fileVersion: active.fileVersion,
      dirty: !matchesSavepoint(active.id, next.document),
      view: active.view,
      revision: active.revision + 1,
    } : document));
    setStatus(`Redid document edit · ${next.length.toLocaleString()} bp`);
  }

  async function saveDocument(documentId: string, saveAs = false) {
    const savingDocument = documentsRef.current.find((document) => document.id === documentId);
    if (!savingDocument || pendingEditIdsRef.current.has(documentId) || pendingSaveIdsRef.current.has(documentId)) return false;
    if (draftDocumentIdsRef.current.has(documentId)) {
      focusDocumentDraft(documentId);
      return false;
    }
    if (!saveAs && !canSaveDocument(savingDocument, false)) return true;
    let reservedPath: string | null = null;
    setPending(setPendingSaveIds, pendingSaveIdsRef, savingDocument.id, true);
    try {
      const directPath = !saveAs ? directProjectPath(savingDocument) : null;
      const path = directPath ?? await saveDialog({
        defaultPath: defaultProjectPath(savingDocument),
        filters: [{ name: "DOTDNA project", extensions: ["json"] }],
      });
      if (!path) {
        setStatus("Save cancelled");
        return false;
      }
      const resolution = await invoke<SavePathResolution>("resolve_save_path", { path });
      const resolvedPath = resolution.path;
      const openOwner = findOpenDocumentByPath(documentsRef.current, resolvedPath);
      if (openOwner && openOwner.id !== savingDocument.id) {
        setActiveId(openOwner.id);
        setStatus(`${resolvedPath.split("/").at(-1)} is already open in another tab`);
        setAppDiagnostics([{ level: "error", title: "Save As destination is already open", body: `DOTDNA did not overwrite ${openOwner.document.name}. Return to the unsaved document and choose a different file name.` }]);
        setBottomView("Warnings");
        setBottomOpen(true);
        return false;
      }
      const reservedBy = reservedSavePathsRef.current.get(resolvedPath);
      if (reservedBy && reservedBy !== savingDocument.id) {
        setStatus("Another document is already saving to that location");
        setAppDiagnostics([{ level: "error", title: "Save destination is busy", body: "Wait for the other save to finish or choose a different file name." }]);
        setBottomView("Warnings");
        setBottomOpen(true);
        return false;
      }
      reservedSavePathsRef.current.set(resolvedPath, savingDocument.id);
      reservedPath = resolvedPath;
      setStatus(`Saving ${savingDocument.document.name}…`);
      const summary = await invoke<DocumentSummary>("save_document", {
        path: resolvedPath,
        document: savingDocument.document,
        expectedFileVersion: directPath ? savingDocument.fileVersion : resolution.fileVersion,
        destinationMustBeAbsent: !directPath && resolution.fileVersion === null,
      });
      savedContentRef.current[savingDocument.id] = documentSavepoint(savingDocument.document);
      const unchanged = documentsRef.current.find((document) => document.id === savingDocument.id)?.revision === savingDocument.revision;
      updateDocuments((current) => current.map((document) => document.id === savingDocument.id ? {
        ...document,
        path: summary.path,
        format: summary.format,
        fileVersion: summary.fileVersion,
        dirty: document.revision === savingDocument.revision ? false : document.dirty,
      } : document));
      setAppDiagnostics((current) => current.filter((diagnostic) => diagnostic.title !== "Document could not be saved" && diagnostic.title !== "Project changed on disk"));
      setStatus(unchanged ? `${saveAs ? "Saved as" : "Saved"} ${summary.path?.split("/").at(-1) ?? savingDocument.document.name}` : `Saved an earlier revision of ${savingDocument.document.name}; newer edits remain unsaved.`);
      return true;
    } catch (error) {
      const changedOnDisk = String(error).includes("changed on disk");
      setStatus(changedOnDisk ? "Save stopped because the project changed on disk" : `Could not save document: ${String(error)}`);
      setAppDiagnostics([{ level: "error", title: changedOnDisk ? "Project changed on disk" : "Document could not be saved", body: changedOnDisk ? String(error) : `${String(error)} Choose another writable location and try again.` }]);
      setBottomView("Warnings");
      setBottomOpen(true);
      return false;
    } finally {
      if (reservedPath && reservedSavePathsRef.current.get(reservedPath) === savingDocument.id) {
        reservedSavePathsRef.current.delete(reservedPath);
      }
      setPending(setPendingSaveIds, pendingSaveIdsRef, savingDocument.id, false);
    }
  }

  async function saveActiveDocument(saveAs = false) {
    if (!active) return false;
    return saveDocument(active.id, saveAs);
  }

  async function createNewDocument(request: { name: string; sequence: string; circular: boolean }) {
    try {
      setStatus(`Creating ${request.name.trim()}…`);
      const summary = await invoke<DocumentSummary>("create_document", { request });
      const opened = { ...asOpenDocument(summary), dirty: true, view: "sequence" as const };
      savedContentRef.current[opened.id] = null;
      updateDocuments((current) => [...current, opened]);
      setSelectedFeatures((current) => ({ ...current, [opened.id]: null }));
      setActiveId(opened.id);
      setNewDocumentOpen(false);
      setAppDiagnostics([]);
      setStatus(`Created ${opened.document.name} · save to keep this document`);
    } catch (error) {
      setStatus(`Could not create document: ${String(error)}`);
      throw error;
    }
  }

  function discardCloseRequest() {
    if (!closeRequest) return;
    if (closeRequest.kind === "document") {
      removeDocument(closeRequest.id);
      setCloseRequest(null);
      return;
    }
    setCloseRequest(null);
    void getCurrentWindow().destroy();
  }

  async function saveCloseRequest() {
    if (!closeRequest || closeRequestBusy) return;
    setCloseRequestBusy(true);
    try {
      if (closeRequest.kind === "document") {
        if (await saveDocument(closeRequest.id)) {
          removeDocument(closeRequest.id);
          setCloseRequest(null);
        }
        return;
      }
      const dirtyDocuments = documentsRef.current.filter((document) => document.dirty);
      for (const document of dirtyDocuments) {
        if (!await saveDocument(document.id)) return;
      }
      setCloseRequest(null);
      await getCurrentWindow().destroy();
    } finally {
      setCloseRequestBusy(false);
    }
  }

  function updateWorkflowBusy(busy: boolean) {
    workflowBusyRef.current = busy;
    setWorkflowBusy(busy);
  }

  function requestCloseWorkflow() {
    if (!workflow) return;
    if (workflowBusyRef.current) {
      setStatus("Wait for the molecular calculation to finish before closing the workflow");
      return;
    }
    setWorkflow(null);
  }

  function openCommandPalette() {
    if (commandPaletteOpen) return;
    if (blockingModalOpen) {
      setStatus("Finish the open sheet before searching commands");
      return;
    }
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    commandPaletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : commandPaletteLauncherRef.current;
    setActionsOpen(false);
    setCommandPaletteOpen(true);
  }

  function closeCommandPalette(restoreFocus = true) {
    if (!commandPaletteOpen) return;
    setCommandPaletteOpen(false);
    const returnFocus = commandPaletteReturnFocusRef.current;
    commandPaletteReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (!restoreFocus && document.activeElement && document.activeElement !== document.body) return;
      const focusTarget = returnFocus?.isConnected ? returnFocus : commandPaletteLauncherRef.current;
      focusTarget?.focus();
      if (!document.activeElement || document.activeElement === document.body) commandPaletteLauncherRef.current?.focus();
    });
  }

  function toggleCommandPalette() {
    const now = window.performance.now();
    if (now - lastCommandPaletteToggleRef.current < 180) return;
    lastCommandPaletteToggleRef.current = now;
      if (commandPaletteOpen) closeCommandPalette();
    else openCommandPalette();
  }

  function handleMenuAction(id: string) {
    if (id === "view.command-palette") {
      toggleCommandPalette();
      return;
    }
    if (commandPaletteOpen) return;
    if (newDocumentOpen || workflow || annotationEditor || closeRequest) {
      if (id === "file.close" && !closeRequestBusy) {
        if (newDocumentOpen) setStatus("Use Cancel or Create Document to finish the new-document sheet.");
        else if (workflow) requestCloseWorkflow();
        else if (annotationEditor) requestCloseAnnotationEditor();
        else setCloseRequest(null);
      }
      return;
    }
    if (id === "file.new") beginNewDocument();
    else if (id === "file.open") void openFile();
    else if (id === "file.open-folder") void openProjectFolder();
    else if (id === "file.save") void saveActiveDocument();
    else if (id === "file.save-as") void saveActiveDocument(true);
    else if (id === "file.close" && active) closeDocument(active.id);
    else if (id === "edit.undo-document") undoActiveDocument();
    else if (id === "edit.redo-document") redoActiveDocument();
    else if (id === "actions.pcr") chooseWorkflow("PCR");
    else if (id === "actions.inverse-pcr") chooseWorkflow("Inverse PCR");
    else if (id === "actions.overlap-pcr") chooseWorkflow("Overlap-Extension PCR");
    else if (id === "actions.restriction-digest") chooseWorkflow("Restriction Digest");
    else {
      const requestedView = views.find((view) => `view.${view.id}` === id);
      if (requestedView) {
        setActiveView(requestedView.id);
        syncNativeMenu({ ...nativeMenu, activeView: requestedView.id });
      }
    }
  }

  menuActionRef.current = handleMenuAction;

  function chooseWorkflow(next: Exclude<Workflow, null>) {
    if (!active) return;
    if (pendingEditIdsRef.current.has(active.id) || pendingSaveIdsRef.current.has(active.id)) {
      setStatus("Wait for the current edit or save before opening a molecular workflow");
      return;
    }
    const blockingDraft = draftDocumentIdsRef.current.values().next().value as string | undefined;
    if (blockingDraft) {
      focusDocumentDraft(blockingDraft);
      return;
    }
    updateWorkflowBusy(true);
    setWorkflow(next);
    setActionsOpen(false);
  }

  function createPcrProduct(result: PcrCommandResult) {
    const opened = { ...asOpenDocument(result.document), dirty: true };
    savedContentRef.current[opened.id] = null;
    updateDocuments((current) => [...current, opened]);
    setSelectedFeatures((current) => ({ ...current, [opened.id]: opened.document.features.length ? 0 : null }));
    setActiveId(opened.id);
    updateWorkflowBusy(false);
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

  function createDigestFragment(result: DigestCommandResult, fragment: DigestCommandFragment) {
    const template = documentsRef.current.find((document) => document.id === result.templateId);
    if (!template || template.revision !== result.templateRevision) {
      updateWorkflowBusy(false);
      setWorkflow(null);
      setStatus("Digest preview expired because the template changed");
      setAppDiagnostics([{ level: "warn", title: "Digest preview expired", body: "Reopen Restriction Digest to recalculate cuts from the current document revision." }]);
      setBottomView("Warnings");
      setBottomOpen(true);
      return;
    }
    const opened = { ...asOpenDocument(fragment.document), dirty: true };
    savedContentRef.current[opened.id] = null;
    updateDocuments((current) => [...current, opened]);
    setSelectedFeatures((current) => ({ ...current, [opened.id]: opened.document.features.length ? opened.document.features.length - 1 : null }));
    setActiveId(opened.id);
    updateWorkflowBusy(false);
    setWorkflow(null);
    setStatus(`Created ${opened.document.name} · ${fragment.length.toLocaleString()} bp`);
    setDocumentDiagnostics((current) => ({
      ...current,
      [opened.id]: result.warnings.map((warning) => ({ level: "warn", title: "Restriction digest advisory", body: warning })),
    }));
    if (result.warnings.length) {
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
      invalidateDerivedState(documentId);
      updateDocuments((current) => current.map((document) => document.id === documentId && document.revision === editingDocument.revision ? {
        ...document,
        document: summary.document,
        length: summary.length,
        gcPercent: summary.gcPercent,
        unknownBases: summary.unknownBases,
        diagnostics: summary.diagnostics,
        dirty: !matchesSavepoint(documentId, summary.document),
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
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (commandPaletteOpen) return;
      if (newDocumentOpen || workflow || annotationEditor || closeRequest) {
        if (key === "w" && !closeRequestBusy) {
          event.preventDefault();
          if (newDocumentOpen) return;
          if (workflow) requestCloseWorkflow();
          else if (annotationEditor) requestCloseAnnotationEditor();
          else setCloseRequest(null);
        }
        return;
      }
      if (key === "f") {
        event.preventDefault();
        openFind();
      } else if (key === "g") {
        event.preventDefault();
        moveFind(event.shiftKey ? -1 : 1);
      } else if (key === "s") {
        event.preventDefault();
        void saveActiveDocument(event.shiftKey);
      } else if (key === "n") {
        event.preventDefault();
        beginNewDocument();
      } else if (key === "o") {
        event.preventDefault();
        if (event.shiftKey) void openProjectFolder();
        else void openFile();
      } else if (key === "w" && active) {
        event.preventDefault();
        closeDocument(active.id);
      } else if (!editingText && /^[1-5]$/.test(key) && active) {
        event.preventDefault();
        setActiveView(views[Number(key) - 1].id);
      } else if (!editingText && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoActiveDocument();
        else undoActiveDocument();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  function syncNativeMenu(state = nativeMenu) {
    const payload = nativeMenuPayload(state);
    menuStateSyncRef.current = menuStateSyncRef.current
      .catch(() => undefined)
      .then(() => invoke("update_native_menu_state", { state: payload }))
      .catch(() => undefined);
  }

  useEffect(() => {
    syncNativeMenu();
  }, [nativeMenu.newDocument, nativeMenu.openDocument, nativeMenu.openFolder, nativeMenu.commandPalette, nativeMenu.save, nativeMenu.saveAs, nativeMenu.close, nativeMenu.undo, nativeMenu.redo, nativeMenu.changeView, nativeMenu.activeView]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<string>("dotdna-menu", (event) => menuActionRef.current(event.payload)).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onCloseRequested((event) => {
      if (commandPaletteOpenRef.current) {
        commandPaletteOpenRef.current = false;
        commandPaletteReturnFocusRef.current = null;
        setCommandPaletteOpen(false);
      }
      const draftDocumentId = draftDocumentIdsRef.current.values().next().value as string | undefined;
      if (draftDocumentId) {
        event.preventDefault();
        focusDocumentDraft(draftDocumentId);
        window.alert("Apply or cancel the sequence draft before quitting DOTDNA.");
        return;
      }
      if (newDocumentOpenRef.current || workflowRef.current || annotationEditorRef.current) {
        event.preventDefault();
        window.alert(`Finish or cancel the ${newDocumentOpenRef.current ? "new document" : workflowRef.current ? "molecular workflow" : "annotation editor"} sheet before quitting DOTDNA.`);
        return;
      }
      if (pendingEditIdsRef.current.size || pendingSaveIdsRef.current.size) {
        event.preventDefault();
        window.alert("Wait for the current edit or save to finish before quitting DOTDNA.");
        return;
      }
      if (!documentsRef.current.some((document) => document.dirty)) return;
      event.preventDefault();
      setCloseRequest({ kind: "quit" });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const paletteCommands: PaletteCommand[] = [
    { id: "new", label: "New DNA Document", detail: "Create a linear or circular sequence", group: "File", shortcut: "⌘N", keywords: ["sequence"], disabled: !commandEligibility.newDocument, disabledReason: "Finish the current draft or sheet first", run: beginNewDocument },
    { id: "open", label: "Open DNA Document", detail: "Open SnapGene, GenBank, FASTA, text, or DOTDNA", group: "File", shortcut: "⌘O", keywords: ["import file"], disabled: !commandEligibility.openDocument, disabledReason: "Finish the current draft or sheet first", run: () => void openFile() },
    { id: "open-folder", label: "Open Project Folder", detail: "Browse DNA files from a real folder", group: "File", shortcut: "⇧⌘O", keywords: ["workspace directory"], disabled: !commandEligibility.openFolder, disabledReason: "Finish the current draft or sheet first", run: () => void openProjectFolder() },
    { id: "refresh-folder", label: "Refresh Project Folder", detail: "Rescan the current project folder", group: "File", keywords: ["workspace reload"], disabled: !projectFolder || projectFolderLoading, disabledReason: projectFolderLoading ? "Folder scan is already running" : "Open a project folder first", run: () => projectFolder && void scanProjectFolder(projectFolder.path) },
    { id: "save", label: "Save Document", detail: "Save the current DOTDNA project", group: "File", shortcut: "⌘S", disabled: !commandEligibility.save, disabledReason: !active ? "No document is open" : activeBusy ? "Wait for the current edit or save" : "The project already matches disk", run: () => void saveActiveDocument() },
    { id: "save-as", label: "Save Document As…", detail: "Write a new DOTDNA project file", group: "File", shortcut: "⇧⌘S", disabled: !commandEligibility.saveAs, disabledReason: !active ? "No document is open" : "Wait for the current edit or draft", run: () => void saveActiveDocument(true) },
    { id: "close", label: "Close Document", detail: "Close the active tab with unsaved-change protection", group: "File", shortcut: "⌘W", disabled: !commandEligibility.close, disabledReason: !active ? "No document is open" : "Wait for the current edit, save, or draft", run: () => active && closeDocument(active.id) },
    { id: "find", label: "Find Sequence", detail: "Highlight exact or IUPAC DNA matches", group: "Sequence", shortcut: "⌘F", keywords: ["search bases"], disabled: !commandEligibility.changeView, disabledReason: "Open an idle document first", run: openFind },
    { id: "feature", label: "Add Feature", detail: "Annotate one or more sequence intervals", group: "Sequence", keywords: ["annotation"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => openFeatureEditor() },
    { id: "primer", label: "Add Primer", detail: "Design a tailed or mutagenic primer", group: "Sequence", keywords: ["oligo"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => openPrimerEditor() },
    { id: "orfs", label: "Analyze ORFs and Translations", detail: "Find complete ORFs across six reading frames", group: "Sequence", keywords: ["protein amino acid"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: openOrfs },
    ...views.map<PaletteCommand>((view) => ({ id: `view-${view.id}`, label: `Show ${view.label} View`, detail: `Switch the active document to ${view.label}`, group: "View", shortcut: view.shortcut, disabled: !commandEligibility.changeView, disabledReason: "Open an idle document first", run: () => setActiveView(view.id) })),
    { id: "split", label: splitActive ? "Close Map / Sequence Split" : "Open Map / Sequence Split", detail: "Synchronize map and sequence coordinates", group: "View", keywords: ["panes"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: toggleSplit },
    { id: "project-sidebar", label: sidebarOpen ? "Hide Project Sidebar" : "Show Project Sidebar", detail: "Toggle open documents and project files", group: "View", run: () => setSidebarOpen((value) => !value) },
    { id: "inspector", label: inspectorOpen ? "Hide Inspector" : "Show Inspector", detail: "Toggle document and selection details", group: "View", run: () => setInspectorOpen((value) => !value) },
    { id: "monochrome", label: monochrome ? "Use Colored Bases" : "Use Monochrome Bases", detail: "Change sequence base coloring", group: "View", run: () => setMonochrome((value) => !value) },
    { id: "pcr", label: "PCR…", detail: "Amplify between two stored primer sites", group: "Molecular Workflows", keywords: ["amplicon"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => chooseWorkflow("PCR") },
    { id: "inverse-pcr", label: "Inverse PCR…", detail: "Mutate or delete circular DNA", group: "Molecular Workflows", keywords: ["mutagenesis"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => chooseWorkflow("Inverse PCR") },
    { id: "overlap-pcr", label: "Overlap-Extension PCR…", detail: "Join overlapping PCR products", group: "Molecular Workflows", keywords: ["oe pcr assembly"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => chooseWorkflow("Overlap-Extension PCR") },
    { id: "restriction-digest", label: "Restriction Digest…", detail: "Predict complete cleavage and create a selected fragment", group: "Molecular Workflows", keywords: ["digest restriction enzyme cut fragment"], disabled: !active || activeBusy, disabledReason: "Open an idle document first", run: () => chooseWorkflow("Restriction Digest") },
  ];

  const mapPane = active ? <Suspense fallback={<div className="map-loading">Starting accelerated map renderer…</div>}><PlasmidMap name={active.document.name} topology={active.document.topology} sequenceLength={active.length} features={active.document.features} primers={active.document.primers} restrictionSites={restrictionSites} restrictionSitesTruncated={restrictionScan.truncated} selection={activeSelection} selectedFeature={selectedFeature} selectedPrimer={selectedPrimer} onSelectFeature={selectFeature} onSelectPrimer={selectPrimer} onSelectRestrictionSite={selectRestrictionSite} zoom={zoom} showEnzymes={showEnzymes} showFeatureLabels={showFeatureLabels} showPrimers={showPrimers} /></Suspense> : null;
  const sequencePane = active ? <SequenceView key={active.id} sequence={active.document.sequence} monochrome={monochrome} disabled={activeBusy} selection={activeSelection} secondaryIntervals={bottomView === "Find" ? secondaryFindIntervals : []} translation={activeTranslation} features={active.document.features} primers={active.document.primers} onSelectFeature={selectFeature} onSelectPrimer={selectPrimer} onOpenTranslations={openOrfs} initialScrollTop={sequenceScrollTopsRef.current[active.id] ?? 0} onScrollTopChange={(scrollTop) => { sequenceScrollTopsRef.current[active.id] = scrollTop; }} onApply={(sequence) => applySequenceEdit(active.id, sequence)} onDraftStateChange={(dirty) => setDocumentDraftState(active.id, dirty)} /> : null;

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><i><span /><span /><span /></i><strong>DOTDNA</strong><em>LAB</em></div>
        <div className="title-document" data-tauri-drag-region>{active?.document.name ?? "No Document"}{active?.dirty ? " •" : ""}</div>
        <div className="title-actions"><button aria-label="Search Commands" onClick={openCommandPalette} ref={commandPaletteLauncherRef} title="Search Commands… (⌘K)">⌘K</button></div>
      </header>

      <section className="toolbar">
        <div className="tool-group"><ToolButton icon="sidebar" label="Project" active={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)} /><ToolButton icon="new" label="New" onClick={beginNewDocument} /><ToolButton icon="open" label="Open" onClick={() => void openFile()} /><ToolButton icon="save" label="Save" disabled={!activeCanSave || (active ? draftDocumentIds.has(active.id) : false)} onClick={() => void saveActiveDocument()} /><ToolButton icon="saveAs" label="Save As" disabled={!active || activeBusy || draftDocumentIds.has(active.id)} onClick={() => void saveActiveDocument(true)} /></div>
        <div className="tool-divider" />
        <div className="tool-group"><ToolButton icon="undo" label="Undo" disabled={!canUndo} onClick={undoActiveDocument} /><ToolButton icon="redo" label="Redo" disabled={!canRedo} onClick={redoActiveDocument} /></div>
        <div className="tool-divider" />
        <div className="tool-group"><ToolButton icon="annotate" label="Feature" disabled={!active || activeBusy} onClick={() => openFeatureEditor()} /><ToolButton icon="primer" label="Primer" disabled={!active || activeBusy} onClick={() => openPrimerEditor()} />
          <div className="action-menu-wrap"><ToolButton active={actionsOpen} buttonRef={actionsButtonRef} controls="molecular-actions-menu" disabled={!commandEligibility.molecularActions} disabledReason={draftDocumentIds.size ? "Apply or cancel the open draft first" : "Open an idle document first"} expanded={actionsOpen} hasPopup icon="actions" label="Actions" onClick={(event) => {
            const opening = !actionsOpen;
            setActionsOpen(opening);
            if (opening && event.detail === 0) window.requestAnimationFrame(() => actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
          }} onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            setActionsOpen(true);
            window.requestAnimationFrame(() => actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
          }} />
            {actionsOpen && <div aria-label="Molecular actions" className="action-menu" id="molecular-actions-menu" onFocusCapture={(event) => {
              const focusedItem = event.target as HTMLElement;
              if (!(focusedItem instanceof HTMLButtonElement) || focusedItem.getAttribute("role") !== "menuitem") return;
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)').forEach((item) => { item.tabIndex = item === focusedItem ? 0 : -1; });
            }} onKeyDown={(event) => {
              if (event.key === "Tab") {
                setActionsOpen(false);
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
              if (!items.length) return;
              event.preventDefault();
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
              items.forEach((item, index) => { item.tabIndex = index === next ? 0 : -1; });
              items[next].focus();
            }} ref={actionsMenuRef} role="menu"><small role="presentation">MOLECULAR ACTIONS</small><button onClick={() => chooseWorkflow("PCR")} role="menuitem" tabIndex={0}><b>PCR…</b><span>Amplify between primers</span></button><button onClick={() => chooseWorkflow("Inverse PCR")} role="menuitem" tabIndex={-1}><b>Inverse PCR…</b><span>Mutate or delete circular DNA</span></button><button onClick={() => chooseWorkflow("Overlap-Extension PCR")} role="menuitem" tabIndex={-1}><b>Overlap-Extension PCR…</b><span>Join overlapping products</span></button><hr role="presentation" /><button onClick={() => chooseWorkflow("Restriction Digest")} role="menuitem" tabIndex={-1}><b>Restriction Digest…</b><span>Predict complete cleavage and fragments</span></button><button disabled role="menuitem" tabIndex={-1} title="Assembly is planned but not implemented yet."><b>Assembly…</b><span>Planned</span></button></div>}
          </div>
        </div>
        <div className="toolbar-spacer" />
        <div className="tool-group compact"><ToolButton icon="search" label="Find" disabled={!active} onClick={openFind} /><ToolButton icon="split" label="Split" active={splitActive} disabled={!active} onClick={toggleSplit} /><ToolButton icon="inspector" label="Inspector" active={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)} /></div>
      </section>

      <section className={`workspace${sidebarOpen ? "" : " no-sidebar"}${inspectorOpen ? "" : " no-inspector"}${bottomOpen ? "" : " no-bottom"}`}>
        {sidebarOpen && <aside className="project-sidebar">
          <header><strong>PROJECT</strong><button onClick={beginNewDocument} title="New DNA document (⌘N)">＋</button></header>
          <div className="project-search"><Icon name="search" /><input aria-label="Filter open documents and project folder files" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Filter files" /></div>
          <section className="open-documents-section"><h3>OPEN DOCUMENTS <span>{documents.length}</span></h3>{filteredDocuments.length ? filteredDocuments.map((document) => <button aria-label={`${document.document.name}, ${document.dirty ? "unsaved changes" : "saved"}, ${document.length.toLocaleString()} base pairs`} className={document.id === activeId ? "active file-row" : "file-row"} key={document.id} onClick={() => activateDocument(document.id)}><i className={document.document.topology} /><span><strong>{document.document.name}</strong><small>{document.length.toLocaleString()} bp · {document.format}</small></span>{document.dirty && <em title="Unsaved changes">●</em>}</button>) : <p className="folder-empty">{documents.length ? "No open documents match the filter." : "No documents are open."}</p>}</section>
          <div aria-live="polite" className="sr-only" role="status">{projectFolderLoading ? "Scanning project folder for DNA files" : projectFolderError ? `Project folder error: ${projectFolderError}` : projectFolder ? `${projectFolder.name} contains ${projectFolder.files.length}${projectFolder.truncated ? " or more" : ""} supported DNA files` : "No project folder is open"}</div>
          <section aria-busy={projectFolderLoading} className="folder-section">
            <h3>PROJECT FOLDER {projectFolder && <span>{projectFolder.files.length}{projectFolder.truncated ? "+" : ""}</span>}</h3>
            {projectFolder && <div className="folder-root" title={projectFolder.path}><i>▾</i><span><strong>{projectFolder.name}</strong><small>{projectFolder.path}</small></span><button aria-label="Refresh project folder" disabled={projectFolderLoading} onClick={() => void scanProjectFolder(projectFolder.path)} title="Refresh folder">↻</button><button aria-label="Close project folder" onClick={closeProjectFolder} title="Close folder">×</button></div>}
            {projectFolderLoading && <div aria-busy="true" className="folder-state"><span className="folder-spinner" />Scanning DNA files…</div>}
            {projectFolderError && <div className="folder-state error" role="alert"><strong>Folder unavailable</strong><span>{projectFolderError}</span>{(projectFolder?.path ?? projectFolderRequestedPath) && <button onClick={() => void scanProjectFolder(projectFolder?.path ?? projectFolderRequestedPath!)}>Retry</button>}</div>}
            {!projectFolder && !projectFolderLoading && !projectFolderError && <div className="folder-state"><strong>No project folder</strong><span>Open a real folder to browse its DNA files.</span><button onClick={() => void openProjectFolder()}>Open Folder…</button></div>}
            {projectFolder && !projectFolderLoading && filteredProjectFiles.length === 0 && <div className="folder-state"><strong>{projectFolder.files.length && projectSearch ? "No matching DNA files" : "No supported DNA files"}</strong><span>{projectFolder.files.length && projectSearch ? `Nothing in ${projectFolder.name} matches “${projectSearch}”.` : "Add a SnapGene, GenBank, FASTA, DOTDNA, or DNA text file."}</span>{projectFolder.files.length > 0 && projectSearch && <button onClick={() => setProjectSearch("")}>Clear Filter</button>}</div>}
            {projectFolder && filteredProjectFiles.length > 0 && <div aria-label={`DNA files in ${projectFolder.name}`} className="folder-files" role="listbox">{filteredProjectFiles.map((file, index) => {
              const openDocument = findOpenDocumentByPath(documents, file.path);
              const isActive = openDocument?.id === activeId;
              return <button aria-label={`${file.relativePath}, ${file.format}, ${displayFileSize(file.byteLength)}${openDocument ? `, open${openDocument.dirty ? " with unsaved changes" : ""}` : ""}`} aria-selected={isActive} className={`folder-child${isActive ? " active" : ""}${openDocument ? " open" : ""}`} key={file.path} onClick={() => void openDocumentPath(file.path)} onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const target = event.key === "Home" ? 0 : event.key === "End" ? filteredProjectFiles.length - 1 : Math.max(0, Math.min(filteredProjectFiles.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                  projectFileButtonRefs.current[target]?.focus();
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void openDocumentPath(file.path);
                } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
                  const now = window.performance.now();
                  const previous = projectFileTypeaheadRef.current;
                  const query = `${now - previous.at < 700 ? previous.query : ""}${event.key}`.toLowerCase();
                  projectFileTypeaheadRef.current = { query, at: now };
                  const offset = filteredProjectFiles.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.name.toLowerCase().startsWith(query));
                  const wrapped = offset >= 0 ? offset : filteredProjectFiles.findIndex((candidate) => candidate.name.toLowerCase().startsWith(query));
                  if (wrapped >= 0) projectFileButtonRefs.current[wrapped]?.focus();
                }
              }} onFocus={() => setFocusedProjectFilePath(file.path)} ref={(element) => { projectFileButtonRefs.current[index] = element; }} role="option" tabIndex={focusedProjectFilePath === file.path || (!focusedProjectFileVisible && index === 0) ? 0 : -1} title={file.path}><i /><span><strong>{file.name}</strong><small>{file.relativePath} · {file.format} · {displayFileSize(file.byteLength)}</small></span>{openDocument && <em title={openDocument.dirty ? "Open with unsaved changes" : "Open"}>{openDocument.dirty ? "●" : "•"}</em>}</button>;
            })}</div>}
            {projectFolder?.truncated && <p className="folder-warning">Showing the first 2,000 supported files from a bounded scan.</p>}
            {projectFolder && projectFolder.warnings.length > 0 && <details className="folder-warnings"><summary>{projectFolder.warnings.length} scan warning{projectFolder.warnings.length === 1 ? "" : "s"}</summary>{projectFolder.warnings.slice(0, 10).map((warning) => <p key={warning}>{warning}</p>)}</details>}
          </section>
          <footer><button onClick={() => void openProjectFolder()}>＋ Open Folder… <kbd>⇧⌘O</kbd></button></footer>
        </aside>}

        <section className="document-area">
          <nav className="document-tabs">{documents.length === 0 ? <span>No open documents</span> : documents.map((document) => {
            const busy = pendingEditIds.has(document.id) || pendingSaveIds.has(document.id);
            return <div className={`document-tab${document.id === activeId ? " active" : ""}`} key={document.id}><button className="document-tab-main" onClick={() => activateDocument(document.id)}><i className={document.document.topology} /><span>{document.document.name}</span>{document.dirty && <em>●</em>}</button><button className="document-tab-close" disabled={busy} title={busy ? "Wait for the current edit or save to finish." : undefined} onClick={() => closeDocument(document.id)} aria-label={`Close ${document.document.name}`}>×</button></div>;
          })}</nav>
          {active ? <>
            <nav className="view-tabs">{views.map((view) => <button className={active.view === view.id ? "active" : ""} key={view.id} onClick={() => setActiveView(view.id)} title={view.shortcut}>{view.label}</button>)}<span /><label><input checked={monochrome} onChange={(event) => setMonochrome(event.target.checked)} type="checkbox" /> Monochrome bases</label></nav>
            <div className={`view-content${splitActive ? " split-active" : ""}`}>
              {splitActive ? <SplitWorkspace ratio={splitRatio} onRatioChange={(ratio) => setSplitRatios((current) => ({ ...current, [active.id]: ratio }))} focusedPane={active.view === "map" ? "map" : "sequence"} onFocusPane={(pane) => setActiveView(pane)} map={mapPane} sequence={sequencePane} /> : <>
              {active.view === "map" && mapPane}
              {active.view === "sequence" && sequencePane}
              {active.view === "features" && <FeatureTable features={active.document.features} selected={selectedFeature} onSelect={selectFeatureRow} onReveal={selectFeature} onNew={() => openFeatureEditor()} onEdit={(index) => openFeatureEditor(index)} />}
              {active.view === "primers" && <PrimerTable document={active} checks={primerChecks} selected={selectedPrimer} onSelect={selectPrimerRow} onReveal={selectPrimer} onNew={() => openPrimerEditor()} onEdit={(index) => openPrimerEditor(index)} />}
              {active.view === "history" && <HistoryView document={active} />}
              </>}
            </div>
          </> : <EmptyWorkspace onNew={beginNewDocument} onOpen={() => void openFile()} />}
        </section>

        {inspectorOpen && <Inspector active={active} selectedFeature={selectedFeature} selection={activeSelection} />}
        {bottomOpen && <BottomPanel view={bottomView} active={active} setView={setBottomPanelView} zoom={zoom} setZoom={setZoom} showEnzymes={showEnzymes} setShowEnzymes={setShowEnzymes} showFeatureLabels={showFeatureLabels} setShowFeatureLabels={setShowFeatureLabels} showPrimers={showPrimers} setShowPrimers={setShowPrimers} primerChecks={primerChecks} restrictionSites={restrictionSites} restrictionSitesTruncated={restrictionScan.truncated} selectedRestrictionId={activeSelection?.source === "restriction" ? activeSelection.entityId : null} onSelectRestrictionSite={selectRestrictionSite} diagnostics={[...appDiagnostics, ...(active ? documentDiagnostics[active.id] ?? [] : [])]} findProps={{
          query: findQuery,
          validationError: findValidation.error ?? visibleFindAnalysis?.error ?? null,
          loading: visibleFindAnalysis?.loading ?? false,
          count: findMatches.length,
          capped: visibleFindAnalysis?.capped ?? false,
          index: findIndex,
          focusToken: findFocusToken,
          onQueryChange: changeFindQuery,
          onMove: moveFind,
          onClose: () => setBottomView("Map Controls"),
        }} orfProps={{
          documentId: active?.id ?? null,
          state: active && activeOrfState?.revision === active.revision ? activeOrfState : null,
          selectedId: selectedOrf?.id ?? null,
          showTranslation: active ? showTranslations[active.id] ?? true : false,
          onMinimumChange: (minimum) => { if (active) void analyzeOrfs(active, minimum, true); },
          onRefresh: () => { if (active) void analyzeOrfs(active, activeOrfState?.minimumAminoAcids ?? 20, true); },
          onSelect: selectOrf,
          onShowTranslation: (show) => {
            if (!active) return;
            setShowTranslations((current) => ({ ...current, [active.id]: show }));
            if (show && selectedOrf && storedTranslation?.orfId !== selectedOrf.id) void loadOrfTranslation(active, selectedOrf);
          },
        }} />}
      </section>

      <footer className="statusbar"><button onClick={() => setBottomOpen((value) => !value)}>{bottomOpen ? "⌄" : "⌃"}</button><span className="status-ready" /> <strong>{status}</strong><div />{active && <><span>{active.document.topology === "circular" ? "Circular" : "Linear"}</span><span>dsDNA</span><span className="mono">{active.length.toLocaleString()} bp</span><span className="mono">GC {active.gcPercent.toFixed(1)}%</span></>}</footer>
      {newDocumentOpen && <NewDocumentSheet suggestedName={nextUntitledName(documents.map((document) => document.document.name))} onClose={() => setNewDocumentOpen(false)} onCreate={createNewDocument} />}
      {workflow && workflow !== "Restriction Digest" && active && <WorkflowSheet workflow={workflow} active={active} onClose={requestCloseWorkflow} onCreate={createPcrProduct} onBusyChange={updateWorkflowBusy} />}
      {workflow === "Restriction Digest" && active && <DigestSheet key={`${active.id}:${active.revision}`} active={active} siteCounts={restrictionCounts} truncatedEnzymes={restrictionScan.truncatedEnzymes} onClose={requestCloseWorkflow} onCreate={createDigestFragment} onBusyChange={updateWorkflowBusy} />}
      {annotationEditor?.kind === "feature" && annotationDocument && <FeatureEditor key={`${annotationEditor.documentId}:${annotationEditor.revision}:${annotationEditor.index ?? "new"}`} documentName={annotationDocument.document.name} sequence={annotationDocument.document.sequence} topology={annotationDocument.document.topology} feature={annotationEditor.index === null ? null : annotationDocument.document.features[annotationEditor.index] ?? null} suggestedIntervals={annotationEditor.index === null && sequenceSelections[annotationEditor.documentId]?.revision === annotationEditor.revision ? sequenceSelections[annotationEditor.documentId]?.intervals ?? [] : []} onClose={closeAnnotationEditor} onDirtyChange={(dirty) => setDocumentDraftState(annotationEditor.documentId, dirty)} onSave={saveFeatureAnnotation} onDelete={annotationEditor.index === null ? undefined : deleteFeatureAnnotation} />}
      {annotationEditor?.kind === "primer" && annotationDocument && <PrimerEditor key={`${annotationEditor.documentId}:${annotationEditor.revision}:${annotationEditor.index ?? "new"}`} documentName={annotationDocument.document.name} sequence={annotationDocument.document.sequence} topology={annotationDocument.document.topology} primer={annotationEditor.index === null ? null : annotationDocument.document.primers[annotationEditor.index] ?? null} onClose={closeAnnotationEditor} onDirtyChange={(dirty) => setDocumentDraftState(annotationEditor.documentId, dirty)} onSave={savePrimerAnnotation} onDelete={annotationEditor.index === null ? undefined : deletePrimerAnnotation} />}
      {closeRequest && <UnsavedChangesSheet
        documentNames={closeRequest.kind === "quit"
          ? documents.filter((document) => document.dirty).map((document) => document.document.name)
          : documents.filter((document) => document.id === closeRequest.id).map((document) => document.document.name)}
        quitting={closeRequest.kind === "quit"}
        busy={closeRequestBusy}
        onCancel={() => setCloseRequest(null)}
        onDiscard={discardCloseRequest}
        onSave={() => void saveCloseRequest()}
      />}
      {commandPaletteOpen && <CommandPalette commands={paletteCommands} onClose={closeCommandPalette} />}
    </main>
  );
}
