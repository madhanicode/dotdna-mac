"use client";

import { ChangeEvent, DragEvent, FormEvent, useMemo, useRef, useState } from "react";
import { AnalysisPanels } from "./AnalysisPanels";
import { parseSnapGene, SnapGeneData, SnapGeneFeature, toFasta } from "./snapgene";

const numberFormatter = new Intl.NumberFormat("en-US");

type DisplayAnnotation = SnapGeneFeature & {
  id: string;
  isCustom: boolean;
};

function coordinates(range: string | null) {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function formatSequence(sequence: string) {
  const lines: string[] = [];
  for (let index = 0; index < sequence.length; index += 60) {
    const bases = sequence.slice(index, index + 60);
    const grouped = bases.match(/.{1,10}/g)?.join(" ") ?? bases;
    lines.push(`${String(index + 1).padStart(8, " ")}  ${grouped}`);
  }
  return lines.join("\n");
}

function countMotif(sequence: string, motif: string) {
  if (!motif) return 0;
  let count = 0;
  let start = 0;
  while ((start = sequence.indexOf(motif, start)) !== -1) {
    count += 1;
    start += 1;
  }
  return count;
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

  const formattedSequence = useMemo(
    () => (data ? formatSequence(data.sequence) : ""),
    [data],
  );
  const motifHits = useMemo(
    () => (data ? countMotif(data.sequence, motif) : 0),
    [data, motif],
  );
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

  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    setCopied(false);

    try {
      const parsed = parseSnapGene(await file.arrayBuffer());
      setData(parsed);
      setFileName(file.name);
      setMotif("");
      setCustomAnnotations([]);
      setShowAnnotationForm(false);
      setAnnotationError("");
    } catch (caught) {
      setData(null);
      setFileName("");
      setError(caught instanceof Error ? caught.message : "I couldn’t read that file.");
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

  function downloadFasta() {
    if (!data) return;
    const blob = new Blob([toFasta(fileName, data.sequence)], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName.replace(/\.dna$/i, "") + ".fasta";
    link.click();
    URL.revokeObjectURL(url);
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

    setCustomAnnotations((current) => [
      ...current,
      {
        id: `added-${Date.now()}`,
        isCustom: true,
        name,
        type: annotationType.trim() || "misc_feature",
        range: `${start}-${end}`,
        color: annotationColor,
      },
    ]);
    setAnnotationName("");
    setAnnotationStart("1");
    setAnnotationEnd("");
    setAnnotationError("");
    setShowAnnotationForm(false);
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
          <p className="eyebrow">SnapGene sequence reader</p>
          <h1>Your DNA sequence,<br /><em>out in the open.</em></h1>
          <p className="lede">
            Drop in a SnapGene <code>.dna</code> file. Get the full sequence,
            useful stats, annotations, ORFs, restriction sites, and a clean FASTA export in seconds.
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
          <div className="drop-icon" aria-hidden="true">
            <span>↓</span>
          </div>
          <h2>{isDragging ? "Release to read" : "Drop your .dna file here"}</h2>
          <p>or choose one from your computer</p>
          <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>
            Choose SnapGene file <span aria-hidden="true">↗</span>
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept=".dna,application/octet-stream"
            onChange={handleInput}
          />
          <div className="local-processing">
            <span className="lock-dot" aria-hidden="true" />
            Processed locally. Your sequence stays private.
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>
      </section>

      {data ? (
        <section className="results" aria-live="polite">
          <div className="result-heading">
            <div>
              <p className="eyebrow cyan">Sequence decoded</p>
              <h2>{fileName}</h2>
            </div>
            <div className="result-actions">
              <button type="button" className="secondary-button" onClick={copySequence}>
                {copied ? "Copied!" : "Copy sequence"}
              </button>
              <button type="button" className="primary-button compact" onClick={downloadFasta}>
                Download FASTA <span aria-hidden="true">↓</span>
              </button>
            </div>
          </div>

          <div className="stat-grid">
            <article><span>Length</span><strong>{numberFormatter.format(data.length)}</strong><small>base pairs</small></article>
            <article><span>GC content</span><strong>{data.gcPercent.toFixed(2)}%</strong><small>canonical bases</small></article>
            <article><span>Topology</span><strong>{data.circular ? "Circular" : "Linear"}</strong><small>{data.doubleStranded ? "double-stranded" : "single-stranded"}</small></article>
            <article><span>Features</span><strong>{annotations.length}</strong><small>{customAnnotations.length ? `${data.features.length} from file · ${customAnnotations.length} added` : "annotations found"}</small></article>
          </div>

          <section className="annotation-section" aria-labelledby="annotation-heading">
            <div className="annotation-header">
              <div>
                <span className="panel-kicker">ANNOTATION MAP</span>
                <h3 id="annotation-heading">What’s on this sequence</h3>
              </div>
              <button
                type="button"
                className={showAnnotationForm ? "secondary-button" : "primary-button compact"}
                onClick={() => { setShowAnnotationForm((current) => !current); setAnnotationError(""); }}
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
                <button type="submit" className="primary-button compact">Save annotation <span aria-hidden="true">↗</span></button>
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
            <p className="session-note">Added annotations stay in this browser session and do not change the original SnapGene file.</p>
          </section>

          <AnalysisPanels sequence={data.sequence} circular={data.circular} />

          <div className="result-layout">
            <div className="sequence-panel">
              <div className="panel-toolbar">
                <div>
                  <span className="panel-kicker">FULL SEQUENCE</span>
                  <span className="base-legend"><i className="a">A</i><i className="c">C</i><i className="g">G</i><i className="t">T</i></span>
                </div>
                <label className="motif-search">
                  <span>Find motif</span>
                  <input
                    value={motif}
                    onChange={(event) => setMotif(event.target.value.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, ""))}
                    placeholder="e.g. GAATTC"
                    spellCheck={false}
                  />
                  {motif && <b>{motifHits} {motifHits === 1 ? "match" : "matches"}</b>}
                </label>
              </div>
              <pre className="sequence-output" tabIndex={0}>{formattedSequence}</pre>
              <div className="sequence-footer">
                <span>{numberFormatter.format(data.length)} bases total</span>
                {data.unknownBases > 0 && <span>{numberFormatter.format(data.unknownBases)} ambiguous</span>}
              </div>
            </div>

            <aside className="features-panel">
              <div className="panel-kicker">ANNOTATIONS</div>
              {annotations.length ? (
                <ol className="feature-list">
                  {annotations.map((feature) => (
                    <li key={feature.id}>
                      <span className="feature-swatch" style={{ backgroundColor: feature.color ?? "#17b6c9" }} />
                      <div><strong>{feature.name}</strong><small>{feature.range ?? feature.type.replaceAll("_", " ")} · {feature.isCustom ? "added" : "file"}</small></div>
                      {feature.isCustom && <button className="remove-annotation" type="button" onClick={() => setCustomAnnotations((current) => current.filter((item) => item.id !== feature.id))} aria-label={`Remove ${feature.name}`}>×</button>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-features">No annotated features were included in this file.</p>
              )}
            </aside>
          </div>
        </section>
      ) : (
        <section className="how-it-works">
          <div className="how-title">
            <p className="eyebrow cyan">What comes out</p>
            <h2>From binary file<br />to readable biology.</h2>
          </div>
          <div className="steps">
            <article><span>01</span><h3>Decode</h3><p>Reads the native SnapGene packet format directly in your browser.</p></article>
            <article><span>02</span><h3>Inspect</h3><p>Shows sequence length, GC content, topology, and saved features.</p></article>
            <article><span>03</span><h3>Take it</h3><p>Copy every base or download a ready-to-use FASTA file.</p></article>
          </div>
        </section>
      )}

      <footer>
        <a className="brand footer-brand" href="#top">DOTDNA</a>
        <p>Small tool. Clear sequence.</p>
        <p className="footer-tech">SnapGene .dna → plain text + FASTA</p>
      </footer>
    </main>
  );
}
