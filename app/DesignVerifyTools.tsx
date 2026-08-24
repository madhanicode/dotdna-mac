"use client";

import { FormEvent, useState } from "react";
import {
  alignDnaGlobal,
  AssemblyResult,
  assembleByExactOverlap,
  CloningEnd,
  formatPairwiseAlignment,
  PairwiseAlignment,
  parseAssemblyFragments,
  planGoldenGateAssembly,
  planRestrictionCloning,
} from "./design-tools";
import { RESTRICTION_ENZYMES } from "./sequence-analysis";
import { SnapGeneFeature, toFasta } from "./snapgene";

type Props = {
  fileName: string;
  sequence: string;
  circular: boolean;
  features: SnapGeneFeature[];
  activeTab: DesignTab;
  onActiveTabChange: (tab: DesignTab) => void;
  onOpenProduct: (result: AssemblyResult, name: string) => void;
};

export type DesignTab = "assembly" | "alignment";
type AssemblyMethod = "overlap" | "restriction" | "golden-gate";

const numberFormatter = new Intl.NumberFormat("en-US");

function download(name: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function endLabel(end?: CloningEnd) {
  if (!end) return "uncharacterized end";
  return end.polarity === "blunt" ? `${end.enzyme} blunt` : `${end.enzyme} ${end.polarity} ${end.overhang}`;
}

export function DesignVerifyTools({ fileName, sequence, circular, features, activeTab: tab, onActiveTabChange, onOpenProduct }: Props) {
  const stem = fileName.replace(/\.[^.]+$/, "") || "sequence";
  const [assemblyMethod, setAssemblyMethod] = useState<AssemblyMethod>("overlap");
  const [assemblyName, setAssemblyName] = useState(`${stem}_assembly`);
  const [assemblyInput, setAssemblyInput] = useState("");
  const [minimumOverlap, setMinimumOverlap] = useState("20");
  const [circularProduct, setCircularProduct] = useState(false);
  const [leftEnzyme, setLeftEnzyme] = useState("EcoRI");
  const [rightEnzyme, setRightEnzyme] = useState("HindIII");
  const [goldenGateEnzyme, setGoldenGateEnzyme] = useState("BsaI");
  const [firstIsVector, setFirstIsVector] = useState(true);
  const [assemblyResult, setAssemblyResult] = useState<AssemblyResult | null>(null);
  const [assemblyError, setAssemblyError] = useState("");
  const [referenceStart, setReferenceStart] = useState("1");
  const [referenceEnd, setReferenceEnd] = useState(String(Math.min(1500, sequence.length)));
  const [query, setQuery] = useState("");
  const [alignment, setAlignment] = useState<PairwiseAlignment | null>(null);
  const [alignmentError, setAlignmentError] = useState("");

  function runAssembly(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAssemblyError("");
    try {
      const fragments = parseAssemblyFragments(assemblyInput).map((fragment) => fragment.sequence === sequence
        ? { ...fragment, features, circular }
        : fragment);
      if (assemblyMethod === "overlap") {
        setAssemblyResult(assembleByExactOverlap(fragments, {
          minimumOverlap: Number(minimumOverlap),
          circular: circularProduct,
        }));
      } else if (assemblyMethod === "restriction") {
        setAssemblyResult(planRestrictionCloning(fragments.map((fragment, index) => ({
          ...fragment,
          circular: index === 0 && firstIsVector,
          leftEnzyme,
          rightEnzyme,
          retain: index === 0 && firstIsVector ? "outside" as const : "between" as const,
        })), { circular: circularProduct }));
      } else {
        setAssemblyResult(planGoldenGateAssembly(fragments, {
          enzyme: goldenGateEnzyme,
          circular: circularProduct,
        }));
      }
    } catch (caught) {
      setAssemblyResult(null);
      setAssemblyError(caught instanceof Error ? caught.message : "The fragments could not be assembled.");
    }
  }

  function useCurrentAsFragment() {
    setAssemblyInput((current) => `${current.trim()}${current.trim() ? "\n" : ""}>${stem}\n${sequence}\n>fragment_2\n`);
    setAssemblyResult(null);
  }

  function changeAssemblyMethod(method: AssemblyMethod) {
    setAssemblyMethod(method);
    setAssemblyResult(null);
    setAssemblyError("");
    setCircularProduct(method !== "overlap");
  }

  function runAlignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAlignmentError("");
    const start = Number(referenceStart);
    const end = Number(referenceEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sequence.length) {
      setAlignment(null);
      setAlignmentError(`Use a reference range between 1 and ${numberFormatter.format(sequence.length)}.`);
      return;
    }
    try {
      setAlignment(alignDnaGlobal(sequence.slice(start - 1, end), query));
    } catch (caught) {
      setAlignment(null);
      setAlignmentError(caught instanceof Error ? caught.message : "The sequences could not be aligned.");
    }
  }

  const formattedAlignment = alignment ? formatPairwiseAlignment(alignment) : "";

  return (
    <section className="design-verify-tools" id="design" aria-labelledby="design-verify-heading">
      <div className="workspace-section-heading">
        <div>
          <span className="panel-kicker">ASSEMBLE · COMPARE · VERIFY</span>
          <h3 id="design-verify-heading">Build and check constructs</h3>
        </div>
        <div className="tool-tabs" role="tablist" aria-label="Assembly and verification tools">
          <button type="button" role="tab" aria-selected={tab === "assembly"} className={tab === "assembly" ? "active" : ""} onClick={() => onActiveTabChange("assembly")}>Assembly</button>
          <button type="button" role="tab" aria-selected={tab === "alignment"} className={tab === "alignment" ? "active" : ""} onClick={() => onActiveTabChange("alignment")}>Alignment</button>
        </div>
      </div>

      {tab === "assembly" && (
        <div className="assembly-workspace" role="tabpanel">
          <form className="assembly-form" onSubmit={runAssembly}>
            <span className="tool-panel-label">ASSEMBLY PLANNER</span>
            <label><span>Product name</span><input value={assemblyName} onChange={(event) => setAssemblyName(event.target.value)} /></label>
            <label>
              <span>Method</span>
              <select value={assemblyMethod} onChange={(event) => changeAssemblyMethod(event.target.value as AssemblyMethod)}>
                <option value="overlap">Exact-overlap assembly</option>
                <option value="restriction">Restriction cloning</option>
                <option value="golden-gate">Golden Gate</option>
              </select>
            </label>
            <label><span>Fragments in assembly order</span><textarea value={assemblyInput} onChange={(event) => setAssemblyInput(event.target.value.toUpperCase())} placeholder={">vector\n…DNA ending in overlap…\n>insert\n…same overlap followed by insert…"} spellCheck={false} /></label>
            <button type="button" className="inline-tool-button" onClick={useCurrentAsFragment}>+ Use current sequence as a fragment</button>
            {assemblyMethod === "overlap" && (
              <label><span>Minimum overlap</span><div className="unit-input dark-unit"><input type="number" min="1" max="200" value={minimumOverlap} onChange={(event) => setMinimumOverlap(event.target.value)} /><b>bp</b></div></label>
            )}
            {assemblyMethod === "restriction" && (
              <>
                <div className="assembly-option-row">
                  <label><span>Left enzyme</span><select value={leftEnzyme} onChange={(event) => setLeftEnzyme(event.target.value)}>{RESTRICTION_ENZYMES.map(({ name }) => <option key={name}>{name}</option>)}</select></label>
                  <label><span>Right enzyme</span><select value={rightEnzyme} onChange={(event) => setRightEnzyme(event.target.value)}>{RESTRICTION_ENZYMES.map(({ name }) => <option key={name}>{name}</option>)}</select></label>
                </div>
                <label className="assembly-check"><input type="checkbox" checked={firstIsVector} onChange={(event) => setFirstIsVector(event.target.checked)} /><span>First fragment is a circular vector; retain its backbone outside the two sites</span></label>
              </>
            )}
            {assemblyMethod === "golden-gate" && (
              <label><span>Type IIS enzyme</span><select value={goldenGateEnzyme} onChange={(event) => setGoldenGateEnzyme(event.target.value)}>{RESTRICTION_ENZYMES.filter(({ kind }) => kind === "Type IIS").map(({ name, recognition }) => <option key={name} value={name}>{name} · {recognition}</option>)}</select></label>
            )}
            <label className="assembly-check"><input type="checkbox" checked={circularProduct} onChange={(event) => setCircularProduct(event.target.checked)} /><span>Circular product</span></label>
            <p>{assemblyMethod === "overlap"
              ? "Fragments are joined in order; each downstream fragment is also tested in reverse-complement orientation."
              : assemblyMethod === "restriction"
                ? "The enzyme sites define each retained fragment. DOTDNA checks sticky/blunt end chemistry at every junction and can reorient inserts."
                : "Each part needs an inward-facing Type IIS site at both ends. DOTDNA removes those sites, checks every overhang, and flags internal sites or ambiguous junctions."}</p>
            {assemblyError && <p className="tool-error" role="alert">{assemblyError}</p>}
            <button className="primary-button compact" type="submit">Plan assembly <span aria-hidden="true">↗</span></button>
          </form>

          <div className="assembly-result">
            {assemblyResult ? (
              <>
                <div className="design-result-heading"><div><span className="tool-panel-label">{assemblyResult.valid ? "ASSEMBLED PRODUCT" : "PLAN NEEDS CHANGES"}</span><h4>{assemblyName || "Assembly product"}</h4></div><span className={`topology-badge ${assemblyResult.valid ? "" : "invalid"}`}>{assemblyResult.valid ? (assemblyResult.circular ? "Circular" : "Linear") : "Blocked"}</span></div>
                <div className="assembly-stat-row"><span><strong>{numberFormatter.format(assemblyResult.sequence.length)}</strong> bp</span><span><strong>{assemblyResult.fragments.length}</strong> fragments</span><span><strong>{assemblyResult.junctions.length}</strong> junctions</span><span><strong>{assemblyResult.features.length}</strong> features</span></div>
                <ol className="junction-list">
                  {assemblyResult.junctions.map((junction, index) => <li className={junction.compatible === false ? "invalid" : ""} key={`${junction.left}-${junction.right}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{junction.left} → {junction.right}</strong><small>{junction.leftEnd && junction.rightEnd ? `${endLabel(junction.leftEnd)} ↔ ${endLabel(junction.rightEnd)} · ${junction.compatible ? "compatible" : "incompatible"}` : `${junction.overlap} bp exact overlap`}{junction.reverseComplemented ? " · right fragment reverse-complemented" : ""}{junction.closure ? " · circular closure" : ""}</small></div></li>)}
                </ol>
                {assemblyResult.warnings.length > 0 && <ul className="assembly-warning-list" aria-label="Assembly warnings">{assemblyResult.warnings.map((warning, index) => <li className={warning.severity} key={`${warning.code}-${index}`}><strong>{warning.severity === "error" ? "Fix required" : "Check design"}</strong><span>{warning.message}</span></li>)}</ul>}
                <code className="assembly-preview">{assemblyResult.sequence.slice(0, 180)}{assemblyResult.sequence.length > 180 ? "…" : ""}</code>
                <div className="assembly-actions"><button type="button" className="secondary-button" disabled={!assemblyResult.valid} onClick={() => download(`${assemblyName || "assembly"}.fasta`, toFasta(assemblyName || "assembly", assemblyResult.sequence))}>Download FASTA</button><button type="button" className="primary-button compact" disabled={!assemblyResult.valid} onClick={() => onOpenProduct(assemblyResult, assemblyName || "assembly")}>Open as workspace</button></div>
                <p className="method-note">Sequence and feature coordinates reflect the planned product. Confirm reaction conditions and enzyme-specific guidance before running the experiment.</p>
              </>
            ) : <div className="tool-empty"><span>↔</span><p>Paste two to twelve FASTA fragments in product order, choose an assembly method and enzymes, then plan the junctions.</p></div>}
          </div>
        </div>
      )}

      {tab === "alignment" && (
        <div className="alignment-workspace" role="tabpanel">
          <form className="alignment-form" onSubmit={runAlignment}>
            <span className="tool-panel-label">GLOBAL PAIRWISE DNA ALIGNMENT</span>
            <div className="design-coordinate-row">
              <label><span>Reference start</span><input type="number" min="1" max={sequence.length} value={referenceStart} onChange={(event) => setReferenceStart(event.target.value)} /></label>
              <label><span>Reference end</span><input type="number" min="1" max={sequence.length} value={referenceEnd} onChange={(event) => setReferenceEnd(event.target.value)} /></label>
            </div>
            <label><span>Query DNA</span><textarea value={query} onChange={(event) => setQuery(event.target.value.toUpperCase())} placeholder="Paste a sequencing read or construct region…" spellCheck={false} /></label>
            <p>Needleman–Wunsch global alignment scores match +2, mismatch −1, and gap −2. Use a focused reference interval for long constructs.</p>
            {alignmentError && <p className="tool-error" role="alert">{alignmentError}</p>}
            <button className="primary-button compact" type="submit">Align sequences <span aria-hidden="true">↗</span></button>
          </form>

          <div className="alignment-result">
            {alignment ? (
              <>
                <span className="tool-panel-label">VERIFICATION RESULT</span>
                <div className="alignment-stat-row"><span><strong>{alignment.identityPercent.toFixed(1)}%</strong> identity</span><span><strong>{numberFormatter.format(alignment.matches)}</strong> matches</span><span><strong>{numberFormatter.format(alignment.mismatches)}</strong> mismatches</span><span><strong>{numberFormatter.format(alignment.gaps)}</strong> gap columns</span><span><strong>{alignment.score}</strong> score</span></div>
                <pre className="alignment-output" tabIndex={0}>{formattedAlignment}</pre>
                <button type="button" className="secondary-button" onClick={() => download(`${stem}_alignment.txt`, `DOTDNA global alignment\nReference: ${referenceStart}-${referenceEnd}\nIdentity: ${alignment.identityPercent.toFixed(2)}%\nScore: ${alignment.score}\n\n${formattedAlignment}\n`)}>Download alignment</button>
                <p className="method-note">Exact character comparison with linear gap penalties. Ambiguous bases match only when the symbols are identical; chromatogram traces and quality scores are not interpreted yet.</p>
              </>
            ) : <div className="tool-empty"><span>≡</span><p>Select a region of the open construct and paste a query sequence to verify substitutions and indels with a global alignment.</p></div>}
          </div>
        </div>
      )}
    </section>
  );
}
