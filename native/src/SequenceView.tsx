import { useEffect, useMemo, useRef, useState } from "react";
import { sequenceRow, visibleRowRange } from "./sequence-layout";

type Props = {
  sequence: string;
  monochrome: boolean;
  disabled?: boolean;
  onApply: (sequence: string) => Promise<void>;
};

const rowHeight = 46;
const lineLength = 60;

function Bases({ value, monochrome }: { value: string; monochrome: boolean }) {
  return (
    <span className={monochrome ? "bases monochrome" : "bases"}>
      {[...value].map((base, index) => <span className={`base base-${base}`} key={`${index}-${base}`}>{base}</span>)}
    </span>
  );
}

export function SequenceView({ sequence, monochrome, disabled = false, onApply }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(580);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sequence);
  const [editError, setEditError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const totalRows = Math.ceil(sequence.length / lineLength);
  const range = visibleRowRange(scrollTop, viewportHeight, totalRows, rowHeight);
  const rows = useMemo(
    () => Array.from({ length: range.last - range.first }, (_, offset) => sequenceRow(sequence, range.first + offset, lineLength)),
    [range.first, range.last, sequence],
  );

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportHeight(viewport.clientHeight));
    setViewportHeight(viewport.clientHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) setDraft(sequence);
  }, [editing, sequence]);

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
    <div className="sequence-view">
      <div className="sequence-ruler">
        <span>5′</span>
        <div><i>10</i><i>20</i><i>30</i><i>40</i><i>50</i><i>60</i></div>
        <span>3′</span>
        <button disabled={disabled} title={disabled ? "Wait for the current edit or save to finish." : undefined} onClick={() => { setDraft(sequence); setEditError(null); setEditing(true); }}>Edit Sequence…</button>
      </div>
      {editing ? <div className="sequence-edit-pane">
        <header><strong>Direct sequence edit</strong><span>Coordinates after the changed interval will shift; overlapping annotations will resize.</span></header>
        <textarea autoFocus spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Editable DNA sequence" />
        <footer><span className="mono">{draft.replace(/[\s\d]/g, "").length.toLocaleString()} bases</span>{editError && <strong>{editError}</strong>}<button disabled={applying} onClick={() => setEditing(false)}>Cancel</button><button className="primary-button" disabled={disabled || applying || draft === sequence} onClick={() => void applyEdit()}>{applying ? "Applying…" : "Apply Edit"}</button></footer>
      </div> : <div
        className="sequence-scroll"
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="region"
        aria-label="DNA sequence viewer"
        tabIndex={0}
      >
        <div className="sequence-spacer" style={{ height: totalRows * rowHeight }}>
          {rows.map((row) => (
            <div className="sequence-row" key={row.index} style={{ top: row.index * rowHeight }}>
              <span className="sequence-coordinate">{(row.start + 1).toLocaleString()}</span>
              <div className="sequence-strands">
                <Bases value={row.forward} monochrome={monochrome} />
                <Bases value={row.complement} monochrome={monochrome} />
              </div>
              <span className="sequence-coordinate end">{row.end.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
}
