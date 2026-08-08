"use client";

import { FormEvent, useMemo, useState } from "react";
import { analyzePrimer, findPrimerBindings, simulatePcr, translateReadingFrame } from "./molecular-biology";
import { SnapGenePrimer, toFasta } from "./snapgene";

type Props = {
  fileName: string;
  sequence: string;
  circular: boolean;
  primers: SnapGenePrimer[];
  onPrimersChange: (primers: SnapGenePrimer[], description: string) => void;
};

type ToolTab = "primers" | "pcr" | "translation";
type ReadingFrame = 1 | 2 | 3 | -1 | -2 | -3;

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

function safePrimerAnalysis(sequence: string) {
  try { return analyzePrimer(sequence); } catch { return null; }
}

export function MolecularTools({ fileName, sequence, circular, primers, onPrimersChange }: Props) {
  const [tab, setTab] = useState<ToolTab>("primers");
  const [primerName, setPrimerName] = useState("");
  const [primerSequence, setPrimerSequence] = useState("");
  const [primerError, setPrimerError] = useState("");
  const [forwardPrimer, setForwardPrimer] = useState("0");
  const [reversePrimer, setReversePrimer] = useState("1");
  const [frame, setFrame] = useState<ReadingFrame>(1);
  const protein = useMemo(() => translateReadingFrame(sequence, frame), [sequence, frame]);
  const pcrProduct = useMemo(() => {
    const forward = primers[Number(forwardPrimer)];
    const reverse = primers[Number(reversePrimer)];
    if (!forward?.sequence || !reverse?.sequence) return null;
    try { return simulatePcr(sequence, forward.sequence, reverse.sequence, circular); } catch { return null; }
  }, [sequence, circular, primers, forwardPrimer, reversePrimer]);

  function addPrimer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrimerError("");
    try {
      const analysis = analyzePrimer(primerSequence);
      const name = primerName.trim() || `Primer ${primers.length + 1}`;
      const bindings = findPrimerBindings(sequence, analysis.sequence, circular);
      const primer: SnapGenePrimer = {
        name,
        sequence: analysis.sequence,
        description: null,
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
      if (!primers.length) {
        setForwardPrimer("0");
        setReversePrimer("0");
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

  return (
    <section className="molecular-tools" id="primers" aria-labelledby="molecular-heading">
      <div className="workspace-section-heading">
        <div>
          <span className="panel-kicker">PRIMERS · PCR · TRANSLATION</span>
          <h3 id="molecular-heading">Routine molecular tools</h3>
        </div>
        <div className="tool-tabs" role="tablist" aria-label="Molecular biology tools">
          <button type="button" role="tab" aria-selected={tab === "primers"} className={tab === "primers" ? "active" : ""} onClick={() => setTab("primers")}>Primers</button>
          <button type="button" role="tab" aria-selected={tab === "pcr"} className={tab === "pcr" ? "active" : ""} onClick={() => setTab("pcr")}>PCR</button>
          <button type="button" role="tab" aria-selected={tab === "translation"} className={tab === "translation" ? "active" : ""} onClick={() => setTab("translation")}>Translation</button>
        </div>
      </div>

      {tab === "primers" && (
        <div className="primer-workspace" role="tabpanel">
          <form className="primer-form" onSubmit={addPrimer}>
            <span className="tool-panel-label">ADD A PRIMER</span>
            <label><span>Name</span><input value={primerName} onChange={(event) => setPrimerName(event.target.value)} placeholder={`Primer ${primers.length + 1}`} /></label>
            <label><span>Sequence (5′→3′)</span><textarea value={primerSequence} onChange={(event) => setPrimerSequence(event.target.value.toUpperCase())} placeholder="ACGT…" spellCheck={false} /></label>
            {primerSequence && safePrimerAnalysis(primerSequence) && (
              <div className="primer-live-stats">
                <span><b>{safePrimerAnalysis(primerSequence)?.length}</b> nt</span>
                <span><b>{safePrimerAnalysis(primerSequence)?.gcPercent.toFixed(1)}%</b> GC</span>
                <span><b>{safePrimerAnalysis(primerSequence)?.meltingTemperature.toFixed(1)}°C</b> Tm</span>
              </div>
            )}
            {primerError && <p className="tool-error" role="alert">{primerError}</p>}
            <button className="primary-button compact" type="submit">Add primer <span aria-hidden="true">↗</span></button>
          </form>

          <div className="primer-library">
            <div className="primer-library-heading"><span className="tool-panel-label">PRIMER LIBRARY</span><b>{primers.length}</b></div>
            {primers.length ? (
              <div className="primer-table-wrap">
                <table className="primer-table">
                  <thead><tr><th>Name</th><th>Sequence 5′→3′</th><th>Length</th><th>Tm</th><th>GC</th><th>Bindings</th><th /></tr></thead>
                  <tbody>
                    {primers.map((primer, index) => {
                      const analysis = safePrimerAnalysis(primer.sequence);
                      const bindings = analysis ? findPrimerBindings(sequence, primer.sequence, circular) : [];
                      return (
                        <tr key={`${primer.name}-${index}`}>
                          <td><strong>{primer.name}</strong></td>
                          <td><code>{primer.sequence}</code></td>
                          <td>{analysis?.length ?? "—"}</td>
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
            ) : <div className="tool-empty"><span>5′</span><p>Add primers to calculate Tm, GC content, exact template binding sites, and PCR products.</p></div>}
          </div>
        </div>
      )}

      {tab === "pcr" && (
        <div className="pcr-workspace" role="tabpanel">
          <div className="pcr-controls">
            <span className="tool-panel-label">EXACT-MATCH PCR</span>
            <label><span>Forward primer</span><select value={forwardPrimer} onChange={(event) => setForwardPrimer(event.target.value)} disabled={!primers.length}>{primers.length ? primers.map((primer, index) => <option value={index} key={`${primer.name}-f-${index}`}>{primer.name}</option>) : <option>No primers</option>}</select></label>
            <label><span>Reverse primer</span><select value={reversePrimer} onChange={(event) => setReversePrimer(event.target.value)} disabled={!primers.length}>{primers.length ? primers.map((primer, index) => <option value={index} key={`${primer.name}-r-${index}`}>{primer.name}</option>) : <option>No primers</option>}</select></label>
            <p>DOTDNA chooses the shortest valid product where the primers face one another. Primer tails and mismatches are not included yet.</p>
          </div>
          <div className="pcr-result">
            {pcrProduct ? (
              <>
                <span className="tool-panel-label">PREDICTED AMPLICON</span>
                <div className="amplicon-stats"><span><strong>{numberFormatter.format(pcrProduct.length)}</strong> bp</span><span><strong>{pcrProduct.gcPercent.toFixed(1)}%</strong> GC</span><span><strong>{pcrProduct.start}–{pcrProduct.end}</strong>{pcrProduct.wrapsOrigin ? " across origin" : " template range"}</span></div>
                <div className="amplicon-map"><i className="primer-arrow forward">5′</i><span /><i className="primer-arrow reverse">5′</i></div>
                <code className="amplicon-preview">{pcrProduct.sequence.slice(0, 110)}{pcrProduct.sequence.length > 110 ? "…" : ""}</code>
                <button type="button" className="secondary-button" onClick={() => download(`${fileName.replace(/\.[^.]+$/, "")}_amplicon.fasta`, toFasta(`${fileName}_amplicon`, pcrProduct.sequence))}>Download amplicon FASTA</button>
              </>
            ) : <div className="tool-empty"><span>PCR</span><p>{primers.length < 2 ? "Add at least two primers, then choose a forward and reverse pair." : "These primers do not form an inward-facing exact-match product on this template."}</p></div>}
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
