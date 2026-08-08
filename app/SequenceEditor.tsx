"use client";

import { FormEvent, useMemo, useState } from "react";
import { SequenceEdit } from "./sequence-edit";

type Props = {
  sequence: string;
  circular: boolean;
  canUndo: boolean;
  canRedo: boolean;
  history: Array<{ description: string; timestamp: string }>;
  onApply: (edit: SequenceEdit) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTopologyChange: (circular: boolean) => void;
};

type EditMode = "insert" | "replace" | "delete";

const numberFormatter = new Intl.NumberFormat("en-US");

function sequencePreview(sequence: string, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sequence.length) return "";
  const selected = sequence.slice(start - 1, end);
  return `${selected.slice(0, 28)}${selected.length > 28 ? "…" : ""}`;
}

export function SequenceEditor({ sequence, circular, canUndo, canRedo, history, onApply, onUndo, onRedo, onTopologyChange }: Props) {
  const [mode, setMode] = useState<EditMode>("insert");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("1");
  const [bases, setBases] = useState("");
  const [error, setError] = useState("");
  const selectedPreview = useMemo(() => sequencePreview(sequence, Number(start), Number(end)), [sequence, start, end]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      if (mode === "insert") onApply({ kind: "insert", position: Number(start), sequence: bases });
      else if (mode === "delete") onApply({ kind: "delete", start: Number(start), end: Number(end) });
      else onApply({ kind: "replace", start: Number(start), end: Number(end), sequence: bases });
      setBases("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit could not be applied.");
    }
  }

  return (
    <section className="editor-section" id="editor" aria-labelledby="editor-heading">
      <div className="workspace-section-heading dark-heading">
        <div>
          <span className="panel-kicker">SEQUENCE EDITOR</span>
          <h3 id="editor-heading">Change the construct safely</h3>
        </div>
        <div className="history-controls">
          <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="Undo last edit">↶ Undo</button>
          <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="Redo last edit">↷ Redo</button>
        </div>
      </div>

      <div className="editor-grid">
        <form className="edit-form" onSubmit={submit}>
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
          <div className="editor-safety"><i />Edits stay in this session until you download a DOTDNA project or sequence file.</div>
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
