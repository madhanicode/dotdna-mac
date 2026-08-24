"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  analyzePrimer,
  designPrimerPair,
  findPrimerBindings,
  PrimerDesignCandidate,
  PrimerDesignPurpose,
  PrimerDesignResult,
  simulateInversePcr,
  simulateOverlapExtensionPcr,
  simulatePcr,
  translateReadingFrame,
} from "./molecular-biology";
import { SnapGenePrimer, toFasta } from "./snapgene";
import { nextSort, SortableTableHeader } from "./SortableTableHeader";
import type { SortState } from "./SortableTableHeader";

type Props = {
  fileName: string;
  sequence: string;
  circular: boolean;
  primers: SnapGenePrimer[];
  activeTab: ToolTab;
  primerSort: SortState<PrimerSortKey>;
  onActiveTabChange: (tab: ToolTab) => void;
  onPrimerSortChange: (sort: SortState<PrimerSortKey>) => void;
  onPrimersChange: (primers: SnapGenePrimer[], description: string) => void;
};

export type ToolTab = "primers" | "design" | "pcr" | "translation";
export type PrimerSortKey = "name" | "sequence" | "length" | "tm" | "gc" | "bindings";
type ReadingFrame = 1 | 2 | 3 | -1 | -2 | -3;
type PcrMode = "standard" | "inverse" | "overlap-extension";

const numberFormatter = new Intl.NumberFormat("en-US");

function download(name: string, contents: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function safePrimerAnalysis(sequence: string, bindingLength?: number) {
  try { return analyzePrimer(sequence, { bindingLength }); } catch { return null; }
}

export function MolecularTools({ fileName, sequence, circular, primers, activeTab: tab, primerSort, onActiveTabChange, onPrimerSortChange, onPrimersChange }: Props) {
  const [primerName, setPrimerName] = useState("");
  const [primerSequence, setPrimerSequence] = useState("");
  const [primerTail, setPrimerTail] = useState("");
  const [primerError, setPrimerError] = useState("");
  const [forwardPrimer, setForwardPrimer] = useState("0");
  const [reversePrimer, setReversePrimer] = useState("1");
  const [internalReversePrimer, setInternalReversePrimer] = useState("1");
  const [internalForwardPrimer, setInternalForwardPrimer] = useState("0");
  const [pcrMode, setPcrMode] = useState<PcrMode>("standard");
  const [designPurpose, setDesignPurpose] = useState<PrimerDesignPurpose>("pcr");
  const [designStart, setDesignStart] = useState("1");
  const [designEnd, setDesignEnd] = useState(String(Math.min(sequence.length, 1000)));
  const [designTm, setDesignTm] = useState("60");
  const [designResult, setDesignResult] = useState<PrimerDesignResult | null>(null);
  const [designError, setDesignError] = useState("");
  const [frame, setFrame] = useState<ReadingFrame>(1);
  const protein = useMemo(() => translateReadingFrame(sequence, frame), [sequence, frame]);
  const primerDraft = useMemo(() => {
    if (!primerSequence) return null;
    try {
      const binding = analyzePrimer(primerSequence);
      const analysis = analyzePrimer(`${primerTail}${binding.sequence}`, { bindingLength: binding.length });
      const bindings = findPrimerBindings(sequence, analysis.sequence, circular, { bindingLength: binding.length });
      const warnings: string[] = [];
      if (!bindings.length) warnings.push("No site passes 3′ validation. Check the binding sequence or keep at least 8 terminal bases identical to the template.");
      if (bindings.length > 1) warnings.push(`${bindings.length} sites pass 3′ validation. Lengthen the binding region to make this primer unique.`);
      if (bindings.some(({ mismatchCount }) => mismatchCount > 0)) warnings.push("Intentional mismatch detected. Confirm the product preview before ordering.");
      if (analysis.meltingTemperature < 50) warnings.push("Annealing Tm is below 50°C. Lengthen the 3′ binding region or lower the reaction annealing temperature.");
      if (analysis.hairpinScore >= 5 || analysis.selfDimerScore >= 6) warnings.push("This oligo has a strong complementary run. Inspect it for hairpins or primer dimers.");
      return { analysis, bindings, warnings };
    } catch {
      return null;
    }
  }, [primerSequence, primerTail, sequence, circular]);
  const pcrProduct = useMemo(() => {
    const forward = primers[Number(forwardPrimer)];
    const reverse = primers[Number(reversePrimer)];
    if (!forward?.sequence || !reverse?.sequence) return null;
    try {
      if (pcrMode === "inverse") {
        if (!circular) return null;
        return simulateInversePcr(sequence, forward.sequence, reverse.sequence, {
          forwardBindingLength: forward.bindingLength,
          reverseBindingLength: reverse.bindingLength,
        });
      }
      if (pcrMode === "overlap-extension") {
        const internalReverse = primers[Number(internalReversePrimer)];
        const internalForward = primers[Number(internalForwardPrimer)];
        if (!internalReverse?.sequence || !internalForward?.sequence) return null;
        return simulateOverlapExtensionPcr(
          sequence,
          forward.sequence,
          internalReverse.sequence,
          internalForward.sequence,
          reverse.sequence,
          circular,
          {
            forwardBindingLength: forward.bindingLength,
            internalReverseBindingLength: internalReverse.bindingLength,
            internalForwardBindingLength: internalForward.bindingLength,
            reverseBindingLength: reverse.bindingLength,
          },
        );
      }
      return simulatePcr(sequence, forward.sequence, reverse.sequence, circular, {
        forwardBindingLength: forward.bindingLength,
        reverseBindingLength: reverse.bindingLength,
      });
    } catch { return null; }
  }, [sequence, circular, primers, forwardPrimer, reversePrimer, internalReversePrimer, internalForwardPrimer, pcrMode]);
  const sortedPrimerRows = useMemo(() => {
    const rows = primers.map((primer, index) => {
      const analysis = safePrimerAnalysis(primer.sequence, primer.bindingLength);
      const bindings = analysis ? findPrimerBindings(sequence, primer.sequence, circular, { bindingLength: primer.bindingLength }) : [];
      return { primer, index, analysis, bindings };
    });
    return rows.sort((left, right) => {
      const key = primerSort.key;
      let comparison = 0;
      if (key === "name") comparison = left.primer.name.localeCompare(right.primer.name);
      if (key === "sequence") comparison = left.primer.sequence.localeCompare(right.primer.sequence);
      if (key === "length") comparison = (left.analysis?.length ?? -1) - (right.analysis?.length ?? -1);
      if (key === "tm") comparison = (left.analysis?.meltingTemperature ?? -1) - (right.analysis?.meltingTemperature ?? -1);
      if (key === "gc") comparison = (left.analysis?.gcPercent ?? -1) - (right.analysis?.gcPercent ?? -1);
      if (key === "bindings") comparison = left.bindings.length - right.bindings.length;
      return (primerSort.direction === "asc" ? comparison : -comparison) || left.primer.name.localeCompare(right.primer.name);
    });
  }, [primers, sequence, circular, primerSort]);

  function addPrimer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrimerError("");
    try {
      const binding = analyzePrimer(primerSequence);
      const analysis = analyzePrimer(`${primerTail}${binding.sequence}`, { bindingLength: binding.length });
      const name = primerName.trim() || `Primer ${primers.length + 1}`;
      const bindings = findPrimerBindings(sequence, analysis.sequence, circular, { bindingLength: analysis.bindingLength });
      const primer: SnapGenePrimer = {
        name,
        sequence: analysis.sequence,
        bindingLength: analysis.bindingLength,
        description: analysis.tailLength ? `5′ tail: ${analysis.tailSequence}` : null,
        color: "#8a6be8",
        phosphorylated: false,
        bindingSites: bindings.map((binding) => ({
          range: `${binding.start}-${binding.end}`,
          start: binding.start,
          end: binding.end,
          boundStrand: binding.strand,
        })),
      };
      onPrimersChange([...primers, primer], `Added primer ${name}`);
      setPrimerName("");
      setPrimerSequence("");
      setPrimerTail("");
      if (!primers.length) {
        setForwardPrimer("0");
        setReversePrimer("0");
        setInternalForwardPrimer("0");
      } else if (primers.length === 1) {
        setReversePrimer("1");
        setInternalReversePrimer("1");
      }
    } catch (caught) {
      setPrimerError(caught instanceof Error ? caught.message : "The primer could not be added.");
    }
  }

  function removePrimer(index: number) {
    const primer = primers[index];
    onPrimersChange(primers.filter((_, itemIndex) => itemIndex !== index), `Removed primer ${primer.name}`);
    setForwardPrimer("0");
    setReversePrimer("0");
  }

  function runPrimerDesign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDesignError("");
    try {
      setDesignResult(designPrimerPair(sequence, Number(designStart), Number(designEnd), {
        purpose: designPurpose,
        desiredTm: Number(designTm),
        circular,
      }));
    } catch (caught) {
      setDesignResult(null);
      setDesignError(caught instanceof Error ? caught.message : "A primer pair could not be designed.");
    }
  }

  function designedPrimer(candidate: PrimerDesignCandidate, suffix: string): SnapGenePrimer {
    const bindings = findPrimerBindings(sequence, candidate.sequence, circular, { bindingLength: candidate.bindingLength });
    return {
      name: `${fileName.replace(/\.[^.]+$/, "")} ${suffix}`,
      sequence: candidate.sequence,
      bindingLength: candidate.bindingLength,
      description: `DOTDNA heuristic design · target ${designStart}-${designEnd}`,
      color: candidate.strand === "+" ? "#ff725e" : "#17b6c9",
      phosphorylated: false,
      bindingSites: bindings.map((binding) => ({
        range: `${binding.start}-${binding.end}`,
        start: binding.start,
        end: binding.end,
        boundStrand: binding.strand,
      })),
    };
  }

  function saveDesignedPair() {
    if (!designResult) return;
    const label = designResult.purpose === "pcr" ? "PCR" : "Seq";
    onPrimersChange([
      ...primers,
      designedPrimer(designResult.forward, `${label} F`),
      designedPrimer(designResult.reverse, `${label} R`),
    ], `Added designed ${designResult.purpose === "pcr" ? "PCR" : "sequencing"} primer pair`);
  }

  return (
    <section className="molecular-tools" id="primers" aria-labelledby="molecular-heading">
      <div className="workspace-section-heading">
        <div>
          <span className="panel-kicker">PRIMERS · PCR · TRANSLATION</span>
          <h3 id="molecular-heading">Routine molecular tools</h3>
        </div>
        <div className="tool-tabs" role="tablist" aria-label="Molecular biology tools">
          <button type="button" role="tab" aria-selected={tab === "primers"} className={tab === "primers" ? "active" : ""} onClick={() => onActiveTabChange("primers")}>Primers</button>
          <button type="button" role="tab" aria-selected={tab === "design"} className={tab === "design" ? "active" : ""} onClick={() => onActiveTabChange("design")}>Design</button>
          <button type="button" role="tab" aria-selected={tab === "pcr"} className={tab === "pcr" ? "active" : ""} onClick={() => onActiveTabChange("pcr")}>PCR</button>
          <button type="button" role="tab" aria-selected={tab === "translation"} className={tab === "translation" ? "active" : ""} onClick={() => onActiveTabChange("translation")}>Translation</button>
        </div>
      </div>

      {tab === "primers" && (
        <div className="primer-workspace" role="tabpanel">
          <form className="primer-form" onSubmit={addPrimer}>
            <span className="tool-panel-label">ADD A PRIMER</span>
            <label><span>Name</span><input value={primerName} onChange={(event) => setPrimerName(event.target.value)} placeholder={`Primer ${primers.length + 1}`} /></label>
            <label><span>Optional 5′ tail / overlap</span><input value={primerTail} onChange={(event) => setPrimerTail(event.target.value.toUpperCase())} placeholder="Non-binding sequence" spellCheck={false} /></label>
            <label><span>3′ template-binding sequence</span><textarea value={primerSequence} onChange={(event) => setPrimerSequence(event.target.value.toUpperCase())} placeholder="ACGT… (intentional mismatches allowed)" spellCheck={false} /></label>
            {primerDraft && (
              <div className="primer-live-stats">
                <span><b>{primerDraft.analysis.length}</b> nt total</span>
                <span><b>{primerDraft.analysis.bindingLength}</b> nt binding</span>
                <span><b>{primerDraft.analysis.gcPercent.toFixed(1)}%</b> binding GC</span>
                <span><b>{primerDraft.analysis.meltingTemperature.toFixed(1)}°C</b> anneal Tm</span>
              </div>
            )}
            {primerDraft && primerDraft.warnings.length > 0 && <ul className="primer-warning-list">{primerDraft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            {primerError && <p className="tool-error" role="alert">{primerError}</p>}
            <button className="primary-button compact" type="submit">Add primer <span aria-hidden="true">↗</span></button>
          </form>

          <div className="primer-library">
            <div className="primer-library-heading"><span className="tool-panel-label">PRIMER LIBRARY</span><b>{primers.length}</b></div>
            {primers.length ? (
              <div className="primer-table-wrap">
                <table className="primer-table">
                  <thead><tr>
                    {([ ["name", "Name", "asc"], ["sequence", "Sequence 5′→3′", "asc"], ["length", "Length", "desc"], ["tm", "Tm", "desc"], ["gc", "GC", "desc"], ["bindings", "Bindings", "desc"] ] as const).map(([key, label, direction]) => <SortableTableHeader key={key} label={label} active={primerSort.key === key} direction={primerSort.direction} onSort={() => onPrimerSortChange(nextSort(primerSort, key, direction))} />)}
                    <th />
                  </tr></thead>
                  <tbody>
                    {sortedPrimerRows.map(({ primer, index, analysis, bindings }) => {
                      return (
                        <tr key={`${primer.name}-${index}`}>
                          <td><strong>{primer.name}</strong></td>
                          <td><code>{primer.sequence}</code></td>
                          <td>{analysis ? `${analysis.length}${analysis.tailLength ? ` (${analysis.bindingLength}+${analysis.tailLength})` : ""}` : "—"}</td>
                          <td>{analysis ? `${analysis.meltingTemperature.toFixed(1)}°` : "—"}</td>
                          <td>{analysis ? `${analysis.gcPercent.toFixed(1)}%` : "—"}</td>
                          <td><span className={bindings.length ? "binding-count bound" : "binding-count"}>{bindings.length}</span></td>
                          <td><button type="button" className="remove-tool-item" onClick={() => removePrimer(index)} aria-label={`Remove ${primer.name}`}>×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="tool-empty"><span>5′</span><p>Add primers to calculate annealing Tm, GC content, validated 3′ template-binding sites, and PCR products.</p></div>}
          </div>
        </div>
      )}

      {tab === "design" && (
        <div className="primer-design-workspace" role="tabpanel">
          <form className="primer-design-form" onSubmit={runPrimerDesign}>
            <span className="tool-panel-label">AUTOMATIC PRIMER DESIGN</span>
            <label><span>Purpose</span><select value={designPurpose} onChange={(event) => { setDesignPurpose(event.target.value as PrimerDesignPurpose); setDesignResult(null); }}><option value="pcr">PCR amplification</option><option value="sequencing">Sequence a target</option></select></label>
            <div className="design-coordinate-row">
              <label><span>Target start</span><input type="number" min="1" max={sequence.length} value={designStart} onChange={(event) => setDesignStart(event.target.value)} /></label>
              <label><span>Target end</span><input type="number" min="1" max={sequence.length} value={designEnd} onChange={(event) => setDesignEnd(event.target.value)} /></label>
            </div>
            <label><span>Desired Tm</span><div className="unit-input dark-unit"><input type="number" min="45" max="75" step="0.5" value={designTm} onChange={(event) => setDesignTm(event.target.value)} /><b>°C</b></div></label>
            <p>{designPurpose === "pcr" ? "Finds an inward-facing pair around the chosen interval." : "Places inward-facing primers outside the target, so both ends need flanking sequence."}</p>
            {designError && <p className="tool-error" role="alert">{designError}</p>}
            <button className="primary-button compact" type="submit">Design pair <span aria-hidden="true">↗</span></button>
          </form>

          <div className="primer-design-result">
            {designResult ? (
              <>
                <div className="design-result-heading"><div><span className="tool-panel-label">RECOMMENDED PAIR</span><h4>{designResult.purpose === "pcr" ? "PCR primers" : "Sequencing primers"}</h4></div><button type="button" className="primary-button compact" onClick={saveDesignedPair}>Add both to library</button></div>
                <div className="designed-primer-grid">
                  {[designResult.forward, designResult.reverse].map((candidate) => (
                    <article key={candidate.strand}>
                      <span className={`strand-pill ${candidate.strand === "+" ? "forward" : "reverse"}`}>{candidate.strand === "+" ? "Forward" : "Reverse"}</span>
                      <code>{candidate.sequence}</code>
                      <dl><div><dt>Template site</dt><dd>{candidate.start}–{candidate.end} ({candidate.strand})</dd></div><div><dt>Length</dt><dd>{candidate.length} nt</dd></div><div><dt>Tm</dt><dd>{candidate.meltingTemperature.toFixed(1)}°C</dd></div><div><dt>GC</dt><dd>{candidate.gcPercent.toFixed(1)}%</dd></div><div><dt>Validated bindings</dt><dd>{candidate.bindingCount}</dd></div></dl>
                      {candidate.warnings.length ? <ul>{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="design-pass">Passes heuristic screens</p>}
                    </article>
                  ))}
                </div>
                <div className="design-pair-summary"><span><strong>{designResult.meltingTemperatureDifference.toFixed(1)}°C</strong> Tm difference</span><span><strong>{designResult.predictedAmpliconLength ? `${numberFormatter.format(designResult.predictedAmpliconLength)} bp` : "—"}</strong> predicted amplicon</span></div>
                {designResult.warnings.length > 0 && <ul className="pcr-warning-list">{designResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                <p className="method-note">Screening-grade design uses nearest-neighbor Tm under default salt/Mg²⁺ conditions plus uniqueness, 3′ stability, homopolymer, hairpin, and dimer screens. Confirm reaction conditions before ordering.</p>
              </>
            ) : <div className="tool-empty"><span>3′</span><p>Choose a target and DOTDNA will score 18–25 nt primers near its boundaries. Designs stay local until you add them to the primer library.</p></div>}
          </div>
        </div>
      )}

      {tab === "pcr" && (
        <div className="pcr-workspace" role="tabpanel">
          <div className="pcr-controls">
            <span className="tool-panel-label">PCR WORKFLOW</span>
            <label><span>Mode</span><select value={pcrMode} onChange={(event) => setPcrMode(event.target.value as PcrMode)}><option value="standard">Standard PCR</option><option value="inverse">Inverse PCR</option><option value="overlap-extension">Overlap-extension PCR</option></select></label>
            <label><span>{pcrMode === "overlap-extension" ? "Outer forward primer" : "Forward primer"}</span><select value={forwardPrimer} onChange={(event) => setForwardPrimer(event.target.value)} disabled={!primers.length}>{primers.length ? primers.map((primer, index) => <option value={index} key={`${primer.name}-f-${index}`}>{primer.name}</option>) : <option>No primers</option>}</select></label>
            {pcrMode === "overlap-extension" && (
              <>
                <label><span>Internal reverse primer</span><select value={internalReversePrimer} onChange={(event) => setInternalReversePrimer(event.target.value)} disabled={!primers.length}>{primers.map((primer, index) => <option value={index} key={`${primer.name}-ir-${index}`}>{primer.name}</option>)}</select></label>
                <label><span>Internal forward primer</span><select value={internalForwardPrimer} onChange={(event) => setInternalForwardPrimer(event.target.value)} disabled={!primers.length}>{primers.map((primer, index) => <option value={index} key={`${primer.name}-if-${index}`}>{primer.name}</option>)}</select></label>
              </>
            )}
            <label><span>{pcrMode === "overlap-extension" ? "Outer reverse primer" : "Reverse primer"}</span><select value={reversePrimer} onChange={(event) => setReversePrimer(event.target.value)} disabled={!primers.length}>{primers.length ? primers.map((primer, index) => <option value={index} key={`${primer.name}-r-${index}`}>{primer.name}</option>) : <option>No primers</option>}</select></label>
            <p>{pcrMode === "standard"
              ? "Finds the shortest inward-facing product. Full primer tails and validated mismatches are incorporated into the amplicon."
              : pcrMode === "inverse"
                ? "Uses an outward-facing pair on a circular template and returns the linear origin-spanning amplicon."
                : "Builds two primary amplicons, verifies an exact 15 bp or longer overlap, and returns their fused product."}</p>
          </div>
          <div className="pcr-result">
            {pcrProduct ? (
              <>
                <span className="tool-panel-label">PREDICTED {pcrProduct.mode.toUpperCase()} PRODUCT</span>
                <div className="amplicon-stats"><span><strong>{numberFormatter.format(pcrProduct.length)}</strong> bp</span><span><strong>{pcrProduct.gcPercent.toFixed(1)}%</strong> GC</span><span><strong>{pcrProduct.start}–{pcrProduct.end}</strong>{pcrProduct.wrapsOrigin ? " across origin" : " template range"}</span></div>
                <div className="amplicon-map"><i className="primer-arrow forward">5′</i><span /><i className="primer-arrow reverse">5′</i></div>
                <code className="amplicon-preview">{pcrProduct.sequence.slice(0, 110)}{pcrProduct.sequence.length > 110 ? "…" : ""}</code>
                <div className="pcr-product-meta"><strong>{pcrProduct.features.length} product features{pcrProduct.overlapLength ? ` · overlap: ${pcrProduct.overlapLength} bp` : ""}</strong></div>
                {pcrProduct.features.some(({ type }) => type !== "primer") && <ol className="pcr-feature-list">{pcrProduct.features.filter(({ type }) => type !== "primer").map((feature, index) => <li key={`${feature.type}-${feature.start}-${index}`}><strong>{feature.name}</strong><span>· {feature.start}–{feature.end} · {feature.type}</span></li>)}</ol>}
                {pcrProduct.warnings.length > 0 && <ul className="pcr-warning-list">{pcrProduct.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                <button type="button" className="secondary-button" onClick={() => download(`${fileName.replace(/\.[^.]+$/, "")}_amplicon.fasta`, toFasta(`${fileName}_amplicon`, pcrProduct.sequence))}>Download amplicon FASTA</button>
              </>
            ) : <div className="tool-empty"><span>PCR</span><p>{primers.length < 2
              ? "Add at least two primers, then choose a primer pair."
              : pcrMode === "inverse" && !circular
                ? "Inverse PCR requires a circular template. Mark the sequence circular or use standard PCR."
                : pcrMode === "inverse"
                  ? "Choose an outward-facing pair: the reverse site must be left of the forward site in displayed coordinates."
                  : pcrMode === "overlap-extension"
                    ? "Check that both primary pairs bind, share an exact overlap of at least 15 bp, and each contribute unique flanking sequence."
                    : "The selected primers lack validated inward-facing 3′ binding sites. Check their binding regions and terminal matches."}</p></div>}
          </div>
        </div>
      )}

      {tab === "translation" && (
        <div className="translation-workspace" role="tabpanel">
          <div className="translation-controls">
            <span className="tool-panel-label">WHOLE-SEQUENCE TRANSLATION</span>
            <label><span>Reading frame</span><select value={frame} onChange={(event) => setFrame(Number(event.target.value) as ReadingFrame)}>{[1, 2, 3, -1, -2, -3].map((item) => <option value={item} key={item}>Frame {item > 0 ? `+${item}` : item}</option>)}</select></label>
            <div className="translation-stats"><span><strong>{numberFormatter.format(protein.length)}</strong> amino acids</span><span><strong>{protein.split("*").length - 1}</strong> stop codons</span></div>
            <button type="button" className="secondary-button" onClick={() => download(`${fileName.replace(/\.[^.]+$/, "")}_frame_${frame}.fasta`, toFasta(`${fileName}_frame_${frame}`, protein))}>Download protein FASTA</button>
          </div>
          <pre className="protein-output" tabIndex={0}>{protein.match(/.{1,60}/g)?.map((line, index) => `${String(index * 60 + 1).padStart(7)}  ${line.match(/.{1,10}/g)?.join(" ")}`).join("\n")}</pre>
        </div>
      )}
    </section>
  );
}
