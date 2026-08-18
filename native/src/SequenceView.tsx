import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { sequenceRow, visibleRowRange } from "./sequence-layout";
import { displayIntervals, intervalContains, selectionLength, type SequenceSelection } from "./sequence-selection";
import type { Feature, OrfTranslation, Primer, SequenceSpan, TranslatedCodon } from "./types";

type Props = {
  sequence: string;
  monochrome: boolean;
  disabled?: boolean;
  onApply: (sequence: string) => Promise<void>;
  onDraftStateChange?: (dirty: boolean) => void;
  selection?: SequenceSelection | null;
  secondaryIntervals?: SequenceSpan[];
  translation?: OrfTranslation | null;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  features?: Feature[];
  primers?: Primer[];
  onSelectFeature?: (index: number) => void;
  onSelectPrimer?: (index: number) => void;
  onOpenTranslations?: () => void;
};

const lineLength = 60;
const annotationLanes = 3;

type TrackAnnotation = {
  id: string;
  label: string;
  color: string;
  span: SequenceSpan;
  kind: string;
  strand: Feature["strand"];
  entity: "feature" | "primer";
  entityIndex: number;
  terminal: boolean;
};

function Bases({ value, start, monochrome, selection, secondaryIntervals, strand, sequenceLength }: {
  value: string;
  start: number;
  monochrome: boolean;
  selection: SequenceSelection | null;
  secondaryIntervals: SequenceSpan[];
  strand: "forward" | "reverse";
  sequenceLength: number;
}) {
  const cutPosition = strand === "forward" ? selection?.cutPositions?.top : selection?.cutPositions?.bottom;
  return (
    <span className={monochrome ? "bases monochrome" : "bases"}>
      {[...value].map((base, index) => {
        const position = start + index;
        const selected = selection ? intervalContains(selection.intervals, position) : false;
        const secondary = !selected && sortedIntervalContains(secondaryIntervals, position);
        const cutBefore = cutPosition === position || (cutPosition === 0 && position === 0);
        const cutAfter = cutPosition === sequenceLength && position === sequenceLength - 1;
        const classes = [
          "base",
          `base-${base}`,
          selected ? `selected selection-${selection?.source}` : "",
          secondary ? "secondary-match" : "",
          cutBefore ? "cut-before" : "",
          cutAfter ? "cut-after" : "",
        ].filter(Boolean).join(" ");
        return <span className={classes} aria-selected={selected || undefined} key={`${position}-${base}`}>{base}</span>;
      })}
    </span>
  );
}

function sortedIntervalContains(intervals: SequenceSpan[], position: number) {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const interval = intervals[middle];
    if (position < interval.start) high = middle - 1;
    else if (position >= interval.end) low = middle + 1;
    else return true;
  }
  return false;
}

function mergeIntervals(intervals: SequenceSpan[]) {
  const sorted = intervals.filter(({ start, end }) => end > start).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SequenceSpan[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function TranslationTrack({ rowStart, rowEnd, codons, translation }: { rowStart: number; rowEnd: number; codons: Map<number, TranslatedCodon>; translation: OrfTranslation }) {
  const direction = translation.strand === "reverse" ? "←" : "→";
  const frame = translation.frame > 0 ? `+${translation.frame}` : translation.frame;
  return <span className="translation-track" data-label={`${frame} ${direction}`} aria-label={`ORF amino-acid translation, frame ${frame}, ${translation.strand} strand`}>
    {Array.from({ length: rowEnd - rowStart }, (_, offset) => {
      const position = rowStart + offset;
      const codon = codons.get(position);
      return <span className={codon ? `codon codon-${codon.kind}` : "codon"} key={position} title={codon ? `${codon.aminoAcid} at base ${position + 1}` : undefined}>{codon?.aminoAcid ?? ""}</span>;
    })}
  </span>;
}

function AnnotationTrack({ rowStart, rowEnd, annotations, onSelectFeature, onSelectPrimer }: {
  rowStart: number;
  rowEnd: number;
  annotations: TrackAnnotation[];
  onSelectFeature?: (index: number) => void;
  onSelectPrimer?: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const laneEnds = Array.from({ length: annotationLanes }, () => -1);
  const visible: Array<{ annotation: TrackAnnotation; lane: number }> = [];
  const overflow: TrackAnnotation[] = [];
  for (const annotation of annotations) {
    const clippedStart = Math.max(rowStart, annotation.span.start);
    const clippedEnd = Math.min(rowEnd, annotation.span.end);
    const lane = laneEnds.findIndex((end) => clippedStart >= end);
    if (lane === -1) overflow.push(annotation);
    else {
      laneEnds[lane] = clippedEnd;
      visible.push({ annotation, lane });
    }
  }
  const select = (annotation: TrackAnnotation) => annotation.entity === "feature" ? onSelectFeature?.(annotation.entityIndex) : onSelectPrimer?.(annotation.entityIndex);
  return <div className="sequence-annotation-track" aria-label="Annotations on this sequence line">
    {visible.map(({ annotation, lane }) => {
      const start = Math.max(rowStart, annotation.span.start) - rowStart;
      const end = Math.min(rowEnd, annotation.span.end) - rowStart;
      const terminal = annotation.terminal && (annotation.strand === "forward" ? annotation.span.end <= rowEnd : annotation.strand === "reverse" ? annotation.span.start >= rowStart : false);
      return <button className={`${annotation.entity}-annotation strand-${annotation.strand}${terminal ? " terminal" : ""}`} key={annotation.id} onClick={() => select(annotation)} style={{ gridColumn: `${start + 1} / ${end + 1}`, gridRow: lane + 1, "--annotation-color": annotation.color } as CSSProperties} title={`${annotation.label} · ${annotation.kind} · ${annotation.strand}`}><span>{annotation.label}</span></button>;
    })}
    {overflow.length > 0 && <button className="annotation-overflow" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>+{overflow.length}</button>}
    {expanded && overflow.length > 0 && <div className="annotation-overflow-menu"><strong>{overflow.length} more annotation{overflow.length === 1 ? "" : "s"}{overflow.length > 100 ? " · showing first 100" : ""}</strong>{overflow.slice(0, 100).map((annotation) => <button key={annotation.id} onClick={() => select(annotation)}><i style={{ background: annotation.color }} /><span>{annotation.label}</span><small>{annotation.kind} · {displayIntervals([annotation.span])}</small></button>)}</div>}
  </div>;
}

export function SequenceView({ sequence, monochrome, disabled = false, onApply, onDraftStateChange, selection = null, secondaryIntervals = [], translation = null, initialScrollTop = 0, onScrollTopChange, features = [], primers = [], onSelectFeature, onSelectPrimer, onOpenTranslations }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [viewportHeight, setViewportHeight] = useState(580);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sequence);
  const [editError, setEditError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [showComplement, setShowComplement] = useState(true);
  const draftStateCallbackRef = useRef(onDraftStateChange);
  const scrollCallbackRef = useRef(onScrollTopChange);
  const initialScrollTopRef = useRef(initialScrollTop);
  draftStateCallbackRef.current = onDraftStateChange;
  scrollCallbackRef.current = onScrollTopChange;
  const rowHeight = 46 + (showAnnotations ? annotationLanes * 14 + 4 : 0) + (translation ? 16 : 0);
  const totalRows = Math.ceil(sequence.length / lineLength);
  const range = visibleRowRange(scrollTop, viewportHeight, totalRows, rowHeight);
  const rows = useMemo(
    () => Array.from({ length: range.last - range.first }, (_, offset) => sequenceRow(sequence, range.first + offset, lineLength)),
    [range.first, range.last, sequence],
  );
  const mergedSecondaryIntervals = useMemo(() => mergeIntervals(secondaryIntervals), [secondaryIntervals]);
  const translatedCodons = useMemo(() => new Map(translation?.codons.map((codon) => [codon.center, codon]) ?? []), [translation]);
  const trackAnnotations = useMemo<TrackAnnotation[]>(() => [
    ...features.flatMap((feature, featureIndex) => feature.segments.map((segment, segmentIndex) => ({
      id: `feature:${feature.id ?? featureIndex}:${segmentIndex}`,
      label: feature.name,
      color: segment.color ?? feature.color ?? "#5cc8d7",
      span: segment.span,
      kind: feature.kind,
      strand: feature.strand,
      entity: "feature" as const,
      entityIndex: featureIndex,
      terminal: feature.strand === "forward" ? segmentIndex === feature.segments.length - 1 : feature.strand === "reverse" && segmentIndex === 0,
    }))),
    ...primers.flatMap((primer, primerIndex) => primer.binding_sites.map((site, siteIndex) => ({
      id: `primer:${primer.id ?? primerIndex}:${siteIndex}`,
      label: primer.name,
      color: primer.color ?? "#79d6e5",
      span: site.span,
      kind: `${site.strand} primer`,
      strand: site.strand,
      entity: "primer" as const,
      entityIndex: primerIndex,
      terminal: site.span.end - site.span.start === primer.binding_length || (site.strand === "forward" ? siteIndex === primer.binding_sites.length - 1 : siteIndex === 0),
    }))),
  ].sort((left, right) => left.span.start - right.span.start || right.span.end - left.span.end), [features, primers]);
  const visibleAnnotations = useMemo(() => {
    const byRow = new Map<number, TrackAnnotation[]>();
    const visibleStart = range.first * lineLength;
    const visibleEnd = range.last * lineLength;
    for (const annotation of trackAnnotations) {
      if (annotation.span.start >= visibleEnd) break;
      if (annotation.span.end <= visibleStart) continue;
      const firstRow = Math.max(range.first, Math.floor(annotation.span.start / lineLength));
      const lastRow = Math.min(range.last - 1, Math.floor((annotation.span.end - 1) / lineLength));
      for (let row = firstRow; row <= lastRow; row += 1) {
        const rowAnnotations = byRow.get(row) ?? [];
        rowAnnotations.push(annotation);
        byRow.set(row, rowAnnotations);
      }
    }
    return byRow;
  }, [range.first, range.last, trackAnnotations]);
  const selectedLength = selection ? selectionLength(selection) : 0;
  const selectedGc = useMemo(() => {
    if (!selection || selectedLength === 0) return null;
    const selected = selection.intervals.map(({ start, end }) => sequence.slice(start, end)).join("");
    const canonical = [...selected].filter((base) => "ACGT".includes(base));
    if (!canonical.length) return null;
    return canonical.filter((base) => base === "G" || base === "C").length / canonical.length * 100;
  }, [selectedLength, selection, sequence]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportHeight(viewport.clientHeight));
    viewport.scrollTop = initialScrollTopRef.current;
    setViewportHeight(viewport.clientHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = scrollRef.current;
    const revealStart = selection?.intervals[0]?.start;
    if (!viewport || revealStart === undefined || editing) return;
    const targetRow = Math.floor(revealStart / lineLength);
    const top = Math.max(0, targetRow * rowHeight - viewport.clientHeight / 2 + rowHeight / 2);
    viewport.scrollTo({ top, behavior: "auto" });
    setScrollTop(top);
    scrollCallbackRef.current?.(top);
  }, [editing, rowHeight, selection?.entityId, selection?.revealToken]);

  useEffect(() => {
    if (!editing) setDraft(sequence);
  }, [editing, sequence]);

  useEffect(() => {
    draftStateCallbackRef.current?.(editing && draft !== sequence);
  }, [draft, editing, sequence]);

  useEffect(() => () => draftStateCallbackRef.current?.(false), []);

  function cancelEdit() {
    if (draft !== sequence && !window.confirm("Discard this unapplied sequence draft?")) return;
    setDraft(sequence);
    setEditError(null);
    setEditing(false);
  }

  async function applyEdit() {
    const normalized = draft.replace(/[\s\d]/g, "").toUpperCase().replaceAll("U", "T");
    const unsupported = normalized.match(/[^ACGTRYSWKMBDHVN-]/)?.[0];
    if (!normalized) {
      setEditError("A DNA document cannot be empty.");
      return;
    }
    if (unsupported) {
      setEditError(`Remove unsupported symbol “${unsupported}” before applying the edit.`);
      return;
    }
    setApplying(true);
    setEditError(null);
    try {
      await onApply(normalized);
      setEditing(false);
    } catch (error) {
      setEditError(String(error));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className={`sequence-view${selection && !editing ? " has-selection" : ""}`}>
      <div className="sequence-toolbar">
        <div className="sequence-title"><strong>Sequence</strong><span className="mono">{sequence.length.toLocaleString()} bp</span></div>
        {selection && !editing && <div className="sequence-selection-stats"><span>Start <strong className="mono">{selection.intervals[0].start + 1}</strong></span><span>End <strong className="mono">{selection.intervals.at(-1)?.end ?? 0}</strong></span><span>Length <strong className="mono">{selectedLength.toLocaleString()} bp</strong></span>{selectedGc !== null && <span>GC <strong className="mono">{selectedGc.toFixed(1)}%</strong></span>}</div>}
        <div />
        <button aria-pressed={showAnnotations} onClick={() => setShowAnnotations((value) => !value)}><i className="annotation-toggle-icon" /> Annotations</button>
        <button aria-pressed={showComplement} onClick={() => setShowComplement((value) => !value)}>≋ Complement</button>
        <button onClick={onOpenTranslations}>Aa Translations…</button>
        <button className="sequence-edit-button" disabled={disabled} title={disabled ? "Wait for the current edit or save to finish." : undefined} onClick={() => { setDraft(sequence); setEditError(null); setEditing(true); }}>Edit</button>
      </div>
      <div className="sequence-ruler">
        <span>5′</span>
        <div><i>10</i><i>20</i><i>30</i><i>40</i><i>50</i><i>60</i></div>
        <span>3′</span>
      </div>
      {selection && !editing && <div className={`sequence-selection-banner selection-${selection.source}`} role="status" aria-live="polite">
        <strong>{selection.label}</strong>
        <span className="mono">{displayIntervals(selection.intervals)} · {selection.strand}</span>
        {selection.detail && <em>{selection.detail}</em>}
      </div>}
      {editing ? <div className="sequence-edit-pane">
        <header><strong>Direct sequence edit</strong><span>Feature coordinates remap after the changed interval; affected stored primer sites are cleared for revalidation.</span></header>
        <textarea autoFocus spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Editable DNA sequence" />
        <footer><span className="mono">{draft.replace(/[\s\d]/g, "").length.toLocaleString()} bases</span>{editError && <strong>{editError}</strong>}<button disabled={applying} onClick={cancelEdit}>Cancel</button><button className="primary-button" disabled={disabled || applying || draft === sequence} onClick={() => void applyEdit()}>{applying ? "Applying…" : "Apply Edit"}</button></footer>
      </div> : <div
        className="sequence-scroll"
        ref={scrollRef}
        onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); scrollCallbackRef.current?.(event.currentTarget.scrollTop); }}
        role="region"
        aria-label="DNA sequence viewer"
        tabIndex={0}
      >
        <div className="sequence-spacer" style={{ height: totalRows * rowHeight }}>
          {rows.map((row) => (
            <div className="sequence-row" key={row.index} style={{ height: rowHeight, top: row.index * rowHeight }}>
              <span className="sequence-coordinate">{(row.start + 1).toLocaleString()}</span>
              <div className="sequence-strands">
                {showAnnotations && <AnnotationTrack rowStart={row.start} rowEnd={row.end} annotations={visibleAnnotations.get(row.index) ?? []} onSelectFeature={onSelectFeature} onSelectPrimer={onSelectPrimer} />}
                <Bases value={row.forward} start={row.start} monochrome={monochrome} selection={selection} secondaryIntervals={mergedSecondaryIntervals} strand="forward" sequenceLength={sequence.length} />
                {translation && <TranslationTrack rowStart={row.start} rowEnd={row.end} codons={translatedCodons} translation={translation} />}
                {showComplement && <Bases value={row.complement} start={row.start} monochrome={monochrome} selection={selection} secondaryIntervals={mergedSecondaryIntervals} strand="reverse" sequenceLength={sequence.length} />}
              </div>
              <span className="sequence-coordinate end">{row.end.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
}
