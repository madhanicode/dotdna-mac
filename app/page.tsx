"use client";

import { ChangeEvent, DragEvent, FormEvent, useMemo, useRef, useState } from "react";
import { AnalysisPanels } from "./AnalysisPanels";
import { DesignVerifyTools } from "./DesignVerifyTools";
import { DocumentInspector } from "./DocumentInspector";
import { MolecularTools } from "./MolecularTools";
import { PlasmidMap } from "./PlasmidMap";
import { SequenceEditor } from "./SequenceEditor";
import type { AssemblyResult } from "./design-tools";
import { applySequenceEdit, SequenceEdit } from "./sequence-edit";
import { parseTextSequence, toDotDnaProject, toGenBank } from "./sequence-formats";
import type { OpenReadingFrame } from "./sequence-analysis";
import { createSequenceData, parseSnapGene, SnapGeneData, SnapGeneFeature, SnapGenePrimer, toFasta, updateSequenceData } from "./snapgene";

const numberFormatter = new Intl.NumberFormat("en-US");

type DisplayAnnotation = SnapGeneFeature & {
  id: string;
  isCustom: boolean;
};

type HistoryEntry = {
  description: string;
  timestamp: string;
};

type WorkspaceSnapshot = {
  data: SnapGeneData;
  customAnnotations: DisplayAnnotation[];
  history: HistoryEntry[];
};

function coordinates(range: string | null) {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<SnapGeneData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [motif, setMotif] = useState("");
  const [customAnnotations, setCustomAnnotations] = useState<DisplayAnnotation[]>([]);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);
  const [annotationName, setAnnotationName] = useState("");
  const [annotationStart, setAnnotationStart] = useState("1");
  const [annotationEnd, setAnnotationEnd] = useState("");
  const [annotationType, setAnnotationType] = useState("misc_feature");
  const [annotationColor, setAnnotationColor] = useState("#17b6c9");
  const [annotationError, setAnnotationError] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [showPasteImport, setShowPasteImport] = useState(false);
  const [pastedName, setPastedName] = useState("pasted-sequence.dna");
  const [pastedSequence, setPastedSequence] = useState("");
  const [pastedCircular, setPastedCircular] = useState(false);
  const [importFormat, setImportFormat] = useState("SnapGene");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [undoStack, setUndoStack] = useState<WorkspaceSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<WorkspaceSnapshot[]>([]);

  const annotations = useMemo<DisplayAnnotation[]>(
    () => [
      ...(data?.features ?? []).map((feature, index) => ({
        ...feature,
        id: `file-${index}`,
        isCustom: false,
      })),
      ...customAnnotations,
    ],
    [data, customAnnotations],
  );

  function loadWorkspace(nextData: SnapGeneData, nextName: string, format: string) {
    setData(nextData);
    setFileName(nextName);
    setImportFormat(format);
    setMotif("");
    setCustomAnnotations([]);
    setShowAnnotationForm(false);
    setEditingAnnotationId(null);
    setAnnotationError("");
    setHistory([]);
    setUndoStack([]);
    setRedoStack([]);
    setShowPasteImport(false);
    setPastedSequence("");
  }

  function currentSnapshot(): WorkspaceSnapshot | null {
    return data ? { data, customAnnotations, history } : null;
  }

  function commitWorkspace(nextData: SnapGeneData, nextCustomAnnotations: DisplayAnnotation[], description: string) {
    const snapshot = currentSnapshot();
    if (snapshot) setUndoStack((current) => [...current, snapshot]);
    setRedoStack([]);
    setData(nextData);
    setCustomAnnotations(nextCustomAnnotations);
    setHistory((current) => [...current, { description, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
  }

  function undo() {
    const previous = undoStack.at(-1);
    const snapshot = currentSnapshot();
    if (!previous || !snapshot) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, snapshot]);
    setData(previous.data);
    setCustomAnnotations(previous.customAnnotations);
    setHistory(previous.history);
  }

  function redo() {
    const next = redoStack.at(-1);
    const snapshot = currentSnapshot();
    if (!next || !snapshot) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, snapshot]);
    setData(next.data);
    setCustomAnnotations(next.customAnnotations);
    setHistory(next.history);
  }

  function applyEdit(edit: SequenceEdit) {
    if (!data) return;
    const fileResult = applySequenceEdit(data.sequence, data.features, edit);
    const customResult = applySequenceEdit(data.sequence, customAnnotations, edit);
    const nextCustom = customResult.features as DisplayAnnotation[];
    commitWorkspace(updateSequenceData(data, fileResult.sequence, { features: fileResult.features }), nextCustom, fileResult.description);
  }

  function changeTopology(circular: boolean) {
    if (!data || data.circular === circular) return;
    commitWorkspace(updateSequenceData(data, data.sequence, { circular }), customAnnotations, circular ? "Circularized the sequence" : "Linearized the sequence");
  }

  function changePrimers(primers: SnapGenePrimer[], description: string) {
    if (!data) return;
    commitWorkspace(updateSequenceData(data, data.sequence, { primers }), customAnnotations, description);
  }

  function createCdsFromOrf(orf: OpenReadingFrame) {
    if (!data) return;
    const color = orf.strand === "+" ? "#ff8a4c" : "#58c882";
    const ranges = orf.wrapsOrigin
      ? [`${orf.start}-${data.length}`, `1-${orf.end}`]
      : [`${orf.start}-${orf.end}`];
    const annotation: DisplayAnnotation = {
      id: `orf-${orf.id}-${Date.now()}`,
      isCustom: true,
      name: `Predicted CDS ${orf.frame > 0 ? "+" : ""}${orf.frame}`,
      type: "CDS",
      range: ranges.join(", "),
      color,
      directionality: orf.strand === "+" ? 1 : 2,
      strand: orf.strand,
      segments: ranges.map((range) => {
        const position = coordinates(range);
        return { range, start: position?.start ?? null, end: position?.end ?? null, color, name: null, type: "standard" };
      }),
      qualifiers: [
        { name: "translation", value: orf.protein },
        { name: "note", value: `Predicted locally by DOTDNA in reading frame ${orf.frame > 0 ? "+" : ""}${orf.frame}` },
      ],
      readingFrame: Math.abs(orf.frame) - 1,
    };
    commitWorkspace(data, [...customAnnotations, annotation], `Created CDS annotation from ORF frame ${orf.frame > 0 ? "+" : ""}${orf.frame}`);
  }

  function openAssemblyProduct(result: AssemblyResult, name: string) {
    const safeName = `${name.trim() || "assembly"}.dna`;
    loadWorkspace(createSequenceData(result.sequence, { circular: result.circular }), safeName, "DOTDNA Assembly");
    window.setTimeout(() => document.querySelector("#map")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    setCopied(false);

    try {
      const buffer = await file.arrayBuffer();
      try {
        const parsed = parseSnapGene(buffer);
        loadWorkspace(parsed, file.name, "SnapGene");
      } catch {
        const imported = parseTextSequence(file.name, new TextDecoder().decode(buffer));
        loadWorkspace(imported.data, imported.name || file.name, imported.format);
      }
    } catch (caught) {
      setData(null);
      setFileName("");
      setError(caught instanceof Error ? caught.message : "I couldn’t read that file.");
    }
  }

  function importPastedSequence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const imported = parseTextSequence(pastedName.trim() || "pasted-sequence.dna", pastedSequence);
      const nextData = imported.format === "Plain DNA" || imported.format === "FASTA"
        ? updateSequenceData(imported.data, imported.data.sequence, { circular: pastedCircular })
        : imported.data;
      loadWorkspace(nextData, imported.name, imported.format);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "I couldn’t read that sequence.");
    }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    void readFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void readFile(event.dataTransfer.files?.[0]);
  }

  async function copySequence() {
    if (!data) return;
    await navigator.clipboard.writeText(data.sequence);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadText(name: string, contents: string, type = "text/plain;charset=utf-8") {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadFasta() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".fasta", toFasta(fileName, data.sequence));
  }

  function downloadGenBank() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".gb", toGenBank(fileName, data, annotations));
  }

  function downloadProject() {
    if (!data) return;
    downloadText(fileName.replace(/\.[^.]+$/i, "") + ".dotdna.json", toDotDnaProject(fileName, data, annotations), "application/json;charset=utf-8");
  }

  function addAnnotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;

    const name = annotationName.trim();
    const start = Number(annotationStart);
    const end = Number(annotationEnd);

    if (!name) {
      setAnnotationError("Give the annotation a name.");
      return;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > data.length) {
      setAnnotationError(`Use a valid range between 1 and ${numberFormatter.format(data.length)}.`);
      return;
    }

    const existing = editingAnnotationId ? annotations.find(({ id }) => id === editingAnnotationId) : null;
    const annotation: DisplayAnnotation = {
      ...(existing ?? {} as DisplayAnnotation),
      id: existing?.id ?? `added-${Date.now()}`,
      isCustom: existing?.isCustom ?? true,
      name,
      type: annotationType.trim() || "misc_feature",
      range: `${start}-${end}`,
      color: annotationColor,
      directionality: 1,
      strand: "+",
      segments: [{ range: `${start}-${end}`, start, end, color: annotationColor, name: null, type: "standard" }],
      qualifiers: [],
      readingFrame: null,
    };
    if (existing && !existing.isCustom) {
      const fileIndex = Number(existing.id.replace("file-", ""));
      const nextFeatures = data.features.map((feature, index) => index === fileIndex ? annotation : feature);
      commitWorkspace(updateSequenceData(data, data.sequence, { features: nextFeatures }), customAnnotations, `Edited annotation ${name}`);
    } else if (existing) {
      commitWorkspace(data, customAnnotations.map((feature) => feature.id === existing.id ? annotation : feature), `Edited annotation ${name}`);
    } else {
      commitWorkspace(data, [...customAnnotations, annotation], `Added annotation ${name}`);
    }
    setAnnotationName("");
    setAnnotationStart("1");
    setAnnotationEnd("");
    setAnnotationError("");
    setShowAnnotationForm(false);
    setEditingAnnotationId(null);
  }

  function saveInlineAnnotation(featureIndex: number | null, draft: { name: string; type: string; color: string; start: number; end: number }) {
    if (!data) return;
    const existing = featureIndex === null ? null : annotations[featureIndex];
    const range = `${draft.start}-${draft.end}`;
    const annotation: DisplayAnnotation = {
      ...(existing ?? {} as DisplayAnnotation),
      id: existing?.id ?? `added-${Date.now()}`,
      isCustom: existing?.isCustom ?? true,
      name: draft.name,
      type: draft.type,
      range,
      color: draft.color,
      directionality: existing?.directionality ?? 1,
      strand: existing?.strand ?? "+",
      segments: [{ range, start: draft.start, end: draft.end, color: draft.color, name: null, type: "standard" }],
      qualifiers: existing?.qualifiers ?? [],
      readingFrame: existing?.readingFrame ?? null,
    };
    if (existing && !existing.isCustom) {
      const fileIndex = Number(existing.id.replace("file-", ""));
      commitWorkspace(updateSequenceData(data, data.sequence, { features: data.features.map((feature, index) => index === fileIndex ? annotation : feature) }), customAnnotations, `Edited annotation ${draft.name}`);
    } else if (existing) {
      commitWorkspace(data, customAnnotations.map((feature) => feature.id === existing.id ? annotation : feature), `Edited annotation ${draft.name}`);
    } else {
      commitWorkspace(data, [...customAnnotations, annotation], `Added annotation ${draft.name}`);
    }
  }

  function removeAnnotation(feature: DisplayAnnotation) {
    if (!data) return;
    if (feature.isCustom) {
      commitWorkspace(data, customAnnotations.filter((item) => item.id !== feature.id), `Removed annotation ${feature.name}`);
      return;
    }
    const fileIndex = Number(feature.id.replace("file-", ""));
    commitWorkspace(updateSequenceData(data, data.sequence, { features: data.features.filter((_, index) => index !== fileIndex) }), customAnnotations, `Removed annotation ${feature.name}`);
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="DOTDNA home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          DOTDNA
        </a>
        <span className="privacy-note"><span />Runs in your browser</span>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Local-first plasmid workspace</p>
          <h1>Your plasmids,<br /><em>ready to work.</em></h1>
          <p className="lede">
            Open SnapGene, GenBank, FASTA, DOTDNA projects, or paste raw DNA. Map, edit,
            annotate, design primers, assemble fragments, verify alignments, simulate PCR and digests,
            translate, and export—all locally.
          </p>
          <div className="hero-proof" aria-label="Product benefits">
            <span>No account</span>
            <span>No upload</span>
            <span>No fuss</span>
          </div>
        </div>

        <div
          className={`drop-card ${isDragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className="corner-label">01 / OPEN</div>
          {showPasteImport ? (
            <form className="paste-import-form" onSubmit={importPastedSequence}>
              <div className="paste-form-heading"><div><span>PASTE OR IMPORT TEXT</span><h2>Start from sequence text</h2></div><button type="button" onClick={() => { setShowPasteImport(false); setError(""); }} aria-label="Close pasted sequence form">×</button></div>
              <label><span>Document name</span><input value={pastedName} onChange={(event) => setPastedName(event.target.value)} /></label>
              <label><span>DNA, FASTA, GenBank, or DOTDNA project</span><textarea value={pastedSequence} onChange={(event) => setPastedSequence(event.target.value)} placeholder=">my_sequence&#10;ACGT…" spellCheck={false} autoFocus /></label>
              <label className="paste-topology"><input type="checkbox" checked={pastedCircular} onChange={(event) => setPastedCircular(event.target.checked)} /><span>Treat raw DNA or FASTA as circular</span></label>
              <button className="primary-button" type="submit">Open sequence <span aria-hidden="true">↗</span></button>
            </form>
          ) : (
            <>
              <div className="drop-icon" aria-hidden="true"><span>↓</span></div>
              <h2>{isDragging ? "Release to read" : "Drop a sequence file here"}</h2>
              <p>.dna · .gb · .fasta · .dotdna.json · text</p>
              <div className="import-actions">
                <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>Choose file <span aria-hidden="true">↗</span></button>
                <button className="ghost-button" type="button" onClick={() => { setShowPasteImport(true); setError(""); }}>Paste sequence</button>
              </div>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept=".dna,.gb,.gbk,.genbank,.fa,.fas,.fasta,.fna,.json,.dotdna,.txt,application/octet-stream,text/plain,application/json"
                onChange={handleInput}
              />
            </>
          )}
          <div className="local-processing">
            <span className="lock-dot" aria-hidden="true" />
            Processed locally. Your sequence stays private.
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>
      </section>

      {data ? (
        <section className="results" aria-live="polite">
          <nav className="workspace-nav" aria-label="Sequence workspace">
            <a href="#map">Map</a>
            <a href="#annotations">Annotations</a>
            <a href="#analysis">ORFs &amp; enzymes</a>
            <a href="#primers">Primers &amp; PCR</a>
            <a href="#design">Assemble &amp; align</a>
            <a href="#editor">Edit</a>
            <a href="#sequence">Sequence</a>
            <a href="#file-details">File details</a>
          </nav>
          <div className="result-heading">
            <div>
              <p className="eyebrow cyan">{importFormat} workspace</p>
              <h2>{fileName}</h2>
            </div>
            <div className="result-actions">
              <button type="button" className="secondary-button" onClick={copySequence}>
                {copied ? "Copied!" : "Copy sequence"}
              </button>
              <details className="export-menu">
                <summary className="primary-button compact">Export <span aria-hidden="true">↓</span></summary>
                <div><button type="button" onClick={downloadFasta}>FASTA sequence</button><button type="button" onClick={downloadGenBank}>GenBank + annotations</button><button type="button" onClick={downloadProject}>DOTDNA project</button></div>
              </details>
              <button type="button" className="new-file-button" onClick={() => { setData(null); setFileName(""); setError(""); setHistory([]); setUndoStack([]); setRedoStack([]); }}>New</button>
            </div>
          </div>

          <div className="stat-grid">
            <article><span>Length</span><strong>{numberFormatter.format(data.length)}</strong><small>base pairs</small></article>
            <article><span>GC content</span><strong>{data.gcPercent.toFixed(2)}%</strong><small>canonical bases</small></article>
            <article><span>Topology</span><strong>{data.circular ? "Circular" : "Linear"}</strong><small>{data.doubleStranded ? "double-stranded" : "single-stranded"}</small></article>
            <article><span>Features</span><strong>{annotations.length}</strong><small>{customAnnotations.length ? `${data.features.length} from file · ${customAnnotations.length} added` : "annotations found"}</small></article>
          </div>

          <PlasmidMap fileName={fileName} sequence={data.sequence} circular={data.circular} features={annotations} />

          <section className="annotation-section" id="annotations" aria-labelledby="annotation-heading">
            <div className="annotation-header">
              <div>
                <span className="panel-kicker">ANNOTATION MAP</span>
                <h3 id="annotation-heading">What’s on this sequence</h3>
              </div>
              <button
                type="button"
                className={showAnnotationForm ? "secondary-button" : "primary-button compact"}
                onClick={() => { const opening = !showAnnotationForm; setShowAnnotationForm(opening); setEditingAnnotationId(null); setAnnotationError(""); if (opening) { setAnnotationName(""); setAnnotationStart("1"); setAnnotationEnd(""); setAnnotationType("misc_feature"); setAnnotationColor("#17b6c9"); } }}
              >
                {showAnnotationForm ? "Cancel" : "+ Add annotation"}
              </button>
            </div>

            {showAnnotationForm && (
              <form className="annotation-form" onSubmit={addAnnotation}>
                <label className="field-wide"><span>Name</span><input value={annotationName} onChange={(event) => setAnnotationName(event.target.value)} placeholder="e.g. promoter" autoFocus /></label>
                <label><span>Start</span><input type="number" min="1" max={data.length} value={annotationStart} onChange={(event) => setAnnotationStart(event.target.value)} /></label>
                <label><span>End</span><input type="number" min="1" max={data.length} value={annotationEnd} onChange={(event) => setAnnotationEnd(event.target.value)} placeholder={String(data.length)} /></label>
                <label><span>Type</span><input value={annotationType} onChange={(event) => setAnnotationType(event.target.value)} /></label>
                <label className="color-field"><span>Color</span><input type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
                <button type="submit" className="primary-button compact">{editingAnnotationId ? "Update annotation" : "Save annotation"} <span aria-hidden="true">↗</span></button>
                {annotationError && <p className="annotation-error" role="alert">{annotationError}</p>}
              </form>
            )}

            {annotations.length ? (
              <div className="annotation-map">
                <div className="annotation-scale"><span>1 bp</span><span>{numberFormatter.format(Math.round(data.length / 2))}</span><span>{numberFormatter.format(data.length)} bp</span></div>
                {annotations.map((feature) => {
                  const position = coordinates(feature.range);
                  const left = position ? ((position.start - 1) / data.length) * 100 : 0;
                  const width = position ? ((position.end - position.start + 1) / data.length) * 100 : 0;
                  return (
                    <div className="annotation-track" key={`map-${feature.id}`}>
                      <div className="annotation-track-label"><strong>{feature.name}</strong><small>{feature.range ?? "no range"}</small></div>
                      <div className="annotation-rail">
                        {position && <span className="annotation-bar" style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%`, backgroundColor: feature.color ?? "#17b6c9" }} title={`${feature.name}: ${feature.range}`} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-features map-empty">No annotations yet. Add the first one above.</p>
            )}
            <p className="session-note">Edits are non-destructive. Export a DOTDNA project or GenBank file when you want to keep them.</p>
          </section>

          <AnalysisPanels key={fileName} sequence={data.sequence} circular={data.circular} onCreateCds={createCdsFromOrf} />

          <MolecularTools key={`${fileName}-molecular`} fileName={fileName} sequence={data.sequence} circular={data.circular} primers={data.primers} onPrimersChange={changePrimers} />

          <DesignVerifyTools key={`${fileName}-design`} fileName={fileName} sequence={data.sequence} onOpenProduct={openAssemblyProduct} />

          <SequenceEditor sequence={data.sequence} circular={data.circular} features={annotations} primers={data.primers} motif={motif} canUndo={undoStack.length > 0} canRedo={redoStack.length > 0} history={history} onApply={applyEdit} onUndo={undo} onRedo={redo} onTopologyChange={changeTopology} onMotifChange={setMotif} onSaveAnnotation={saveInlineAnnotation} onRemoveAnnotation={(featureIndex) => removeAnnotation(annotations[featureIndex])} />

          <DocumentInspector data={data} />
        </section>
      ) : (
        <section className="how-it-works">
          <div className="how-title">
            <p className="eyebrow cyan">What comes out</p>
            <h2>From sequence file<br />to working construct.</h2>
          </div>
          <div className="steps">
            <article><span>01</span><h3>Open</h3><p>Reads SnapGene, GenBank, FASTA, raw DNA, and portable DOTDNA projects.</p></article>
            <article><span>02</span><h3>Work</h3><p>Map, edit, annotate, design primers, assemble, align, digest, and translate.</p></article>
            <article><span>03</span><h3>Export</h3><p>Take FASTA, annotated GenBank, protein, amplicon, map PNG, or a complete project.</p></article>
          </div>
        </section>
      )}

      <footer>
        <a className="brand footer-brand" href="#top">DOTDNA</a>
        <p>Private sequence work, in your browser.</p>
        <p className="footer-tech">.dna · GenBank · FASTA · DOTDNA</p>
      </footer>
    </main>
  );
}
