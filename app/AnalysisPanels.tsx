"use client";

import { useMemo, useState } from "react";
import { sortOrfs, sortRestrictionRows } from "./analysis-sort";
import type { OrfSortKey, RestrictionSortKey, SortDirection } from "./analysis-sort";
import { featureMatchesOrf, isOrfAnnotationStale } from "./orf-annotations";
import { nextSort, SortableTableHeader } from "./SortableTableHeader";
import type { SortState } from "./SortableTableHeader";
import {
  OpenReadingFrame,
  OrfStartMode,
  RESTRICTION_ENZYMES,
  RestrictionSite,
  simulateRestrictionDigest,
} from "./sequence-analysis";
import type { SnapGeneFeature } from "./snapgene";
import { useSequenceAnalysis } from "./useSequenceAnalysis";

type Props = {
  sequence: string;
  circular: boolean;
  annotations?: SnapGeneFeature[];
  preferences: AnalysisPreferences;
  onPreferencesChange: (preferences: AnalysisPreferences) => void;
  onNavigate?: (start: number, end: number) => void;
  onCreateCds?: (orf: OpenReadingFrame) => void;
};

type CutterMode = "all" | "unique" | "double" | "type-iis";
export type AnalysisPreferences = {
  minimumAminoAcids: number;
  startMode: OrfStartMode;
  enzymeQuery: string;
  cutterMode: CutterMode;
  orfSort: SortState<OrfSortKey>;
  restrictionSort: SortState<RestrictionSortKey>;
};

const numberFormatter = new Intl.NumberFormat("en-US");
const frames = [1, 2, 3, -1, -2, -3] as const;

function spanSegments(start: number, end: number, wrapsOrigin: boolean, length: number) {
  if (!wrapsOrigin) {
    return [{ left: ((start - 1) / length) * 100, width: ((end - start + 1) / length) * 100 }];
  }
  return [
    { left: ((start - 1) / length) * 100, width: ((length - start + 1) / length) * 100 },
    { left: 0, width: (end / length) * 100 },
  ];
}

function rangeLabel(item: OpenReadingFrame) {
  return item.wrapsOrigin ? `${item.start} → origin → ${item.end}` : `${item.start}–${item.end}`;
}

function gelPosition(fragmentLength: number, maximumLength: number) {
  const minimum = Math.max(20, Math.min(100, maximumLength));
  const maximum = Math.max(minimum + 1, maximumLength);
  const value = Math.max(minimum, Math.min(maximum, fragmentLength));
  const ratio = (Math.log10(maximum) - Math.log10(value)) / (Math.log10(maximum) - Math.log10(minimum));
  return 10 + ratio * 80;
}

export function AnalysisPanels({ sequence, circular, annotations = [], preferences, onPreferencesChange, onNavigate, onCreateCds }: Props) {
  const { minimumAminoAcids, startMode, enzymeQuery, cutterMode, orfSort, restrictionSort } = preferences;
  const [selectedDigestEnzymes, setSelectedDigestEnzymes] = useState<string[]>([]);

  const { orfs, restrictionSites, pending: analysisPending } = useSequenceAnalysis(sequence, { circular, minimumAminoAcids, startMode });
  const enzymeRows = useMemo(() => {
    const grouped = new Map<string, RestrictionSite[]>();
    for (const site of restrictionSites) {
      const current = grouped.get(site.enzyme.name) ?? [];
      current.push(site);
      grouped.set(site.enzyme.name, current);
    }

    return RESTRICTION_ENZYMES
      .map((enzyme) => ({ enzyme, sites: grouped.get(enzyme.name) ?? [] }))
      .filter(({ sites }) => sites.length > 0);
  }, [restrictionSites]);
  const filteredEnzymeRows = useMemo(() => {
    const query = enzymeQuery.trim().toLowerCase();
    return enzymeRows.filter(({ enzyme, sites }) => {
      if (query && !enzyme.name.toLowerCase().includes(query) && !enzyme.recognition.toLowerCase().includes(query)) return false;
      if (cutterMode === "unique" && sites.length !== 1) return false;
      if (cutterMode === "double" && sites.length !== 2) return false;
      if (cutterMode === "type-iis" && enzyme.kind !== "Type IIS") return false;
      return true;
    });
  }, [enzymeRows, enzymeQuery, cutterMode]);
  const visibleEnzymeRows = useMemo(
    () => sortRestrictionRows(filteredEnzymeRows, restrictionSort.key, restrictionSort.direction),
    [filteredEnzymeRows, restrictionSort],
  );
  const visibleSites = useMemo(
    () => visibleEnzymeRows.flatMap(({ sites }) => sites),
    [visibleEnzymeRows],
  );
  const digest = useMemo(
    () => simulateRestrictionDigest(sequence, selectedDigestEnzymes, circular),
    [sequence, selectedDigestEnzymes, circular],
  );
  const sortedOrfs = useMemo(() => sortOrfs(orfs, orfSort.key, orfSort.direction), [orfs, orfSort]);
  const displayedOrfs = sortedOrfs.slice(0, 10);
  const forwardCount = orfs.filter(({ strand }) => strand === "+").length;
  const reverseCount = orfs.length - forwardCount;

  function toggleDigestEnzyme(name: string) {
    setSelectedDigestEnzymes((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  function updateOrfSort(key: OrfSortKey, defaultDirection: SortDirection = "asc") {
    onPreferencesChange({ ...preferences, orfSort: nextSort(orfSort, key, defaultDirection) });
  }

  function updateRestrictionSort(key: RestrictionSortKey, defaultDirection: SortDirection = "asc") {
    onPreferencesChange({ ...preferences, restrictionSort: nextSort(restrictionSort, key, defaultDirection) });
  }

  return (
    <section className="analysis-suite" id="analysis" aria-labelledby="analysis-heading">
      <div className="analysis-suite-heading">
        <div>
          <span className="panel-kicker">SEQUENCE ANALYSIS</span>
          <h3 id="analysis-heading">Signals hiding in the bases</h3>
        </div>
        <p>Predictions are calculated locally from the uploaded sequence.</p>
      </div>

      <div className="analysis-panels">
        <article className="analysis-card orf-card">
          <header className="analysis-card-header">
            <div>
              <span className="analysis-number">01</span>
              <h4>Open reading frames</h4>
              <p>Six-frame scan with CDS creation linked directly to annotations.</p>
            </div>
            <div className="analysis-controls">
              <label>
                <span>Minimum</span>
                <div className="unit-input"><input type="number" min="5" max="5000" value={minimumAminoAcids} onChange={(event) => onPreferencesChange({ ...preferences, minimumAminoAcids: Math.max(5, Number(event.target.value) || 5) })} /><b>aa</b></div>
              </label>
              <label>
                <span>Start codons</span>
                <select value={startMode} onChange={(event) => onPreferencesChange({ ...preferences, startMode: event.target.value as OrfStartMode })}>
                  <option value="atg">ATG only</option>
                  <option value="common">ATG, GTG, TTG</option>
                </select>
              </label>
            </div>
          </header>

          <div className="analysis-summary">
            <strong>{orfs.length}</strong><span>ORFs found</span>
            {analysisPending && <span className="analysis-pending">Analyzing…</span>}
            <i className="summary-dot forward" /><span>{forwardCount} forward</span>
            <i className="summary-dot reverse" /><span>{reverseCount} reverse</span>
          </div>

          <div className="orf-map" aria-label="Six-frame ORF map">
            <div className="analysis-scale"><span>1</span><span>{numberFormatter.format(Math.round(sequence.length / 2))}</span><span>{numberFormatter.format(sequence.length)} bp</span></div>
            {frames.map((frame) => (
              <div className="orf-frame" key={frame}>
                <b>{frame > 0 ? `+${frame}` : frame}</b>
                <div className="orf-rail">
                  {orfs.filter((orf) => orf.frame === frame).map((orf) => {
                    const matchingFeature = annotations.find((feature) => featureMatchesOrf(feature, orf, sequence.length));
                    const annotated = Boolean(matchingFeature);
                    const stale = matchingFeature ? isOrfAnnotationStale(matchingFeature, sequence) : false;
                    return spanSegments(orf.start, orf.end, orf.wrapsOrigin, sequence.length).map((segment, index) => (
                      <button
                        type="button"
                        className={`orf-bar ${orf.strand === "+" ? "forward" : "reverse"} ${annotated ? "annotated" : ""} ${stale ? "stale" : ""}`}
                        key={`${orf.id}-${index}`}
                        style={{ left: `${segment.left}%`, width: `${Math.max(segment.width, 0.45)}%` }}
                        title={`${stale ? "Annotation needs review" : annotated ? "Annotated CDS" : "Create CDS annotation"} · Frame ${frame > 0 ? "+" : ""}${frame} · ${rangeLabel(orf)} · ${orf.aminoAcidLength} aa`}
                        aria-label={`${stale ? "Annotation needs review" : annotated ? "Annotated CDS" : "Create CDS annotation"} for ORF frame ${frame > 0 ? "+" : ""}${frame}, ${rangeLabel(orf)}`}
                        onClick={() => { if (annotated) onNavigate?.(orf.start, orf.end); else onCreateCds?.(orf); }}
                        disabled={!onCreateCds && !onNavigate}
                      />
                    ));
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="analysis-table-wrap">
            <table className="analysis-table">
              <thead><tr>
                <SortableTableHeader label="Frame" active={orfSort.key === "frame"} direction={orfSort.direction} onSort={() => updateOrfSort("frame")} />
                <SortableTableHeader label="Range" active={orfSort.key === "range"} direction={orfSort.direction} onSort={() => updateOrfSort("range")} />
                <SortableTableHeader label="Length" active={orfSort.key === "length"} direction={orfSort.direction} onSort={() => updateOrfSort("length", "desc")} />
                <SortableTableHeader label="Protein preview" active={orfSort.key === "protein"} direction={orfSort.direction} onSort={() => updateOrfSort("protein")} />
                {onCreateCds && <th>Annotation</th>}
              </tr></thead>
              <tbody>
                {displayedOrfs.map((orf) => {
                  const matchingFeature = annotations.find((feature) => featureMatchesOrf(feature, orf, sequence.length));
                  const stale = matchingFeature ? isOrfAnnotationStale(matchingFeature, sequence) : false;
                  return <tr key={orf.id}>
                    <td><span className={`strand-pill ${orf.strand === "+" ? "forward" : "reverse"}`}>{orf.frame > 0 ? `+${orf.frame}` : orf.frame}</span></td>
                    <td><button type="button" className="table-range-button" onClick={() => onNavigate?.(orf.start, orf.end)}>{rangeLabel(orf)}</button></td>
                    <td>{numberFormatter.format(orf.aminoAcidLength)} aa</td>
                    <td className="protein-preview">{orf.protein.slice(0, 18)}{orf.protein.length > 18 ? "…" : ""}</td>
                    {onCreateCds && <td>{matchingFeature
                      ? <button type="button" className={`orf-annotation-button annotated ${stale ? "stale" : ""}`} onClick={() => onNavigate?.(orf.start, orf.end)}>{stale ? "Review needed" : "Annotated ✓"}</button>
                      : <button type="button" className="orf-annotation-button" onClick={() => onCreateCds(orf)}>Create CDS</button>}</td>}
                  </tr>;
                })}
              </tbody>
            </table>
            {!orfs.length && <p className="analysis-empty">No complete ORFs meet these criteria.</p>}
            {orfs.length > displayedOrfs.length && <p className="table-note">Showing 10 of {orfs.length} ORFs in the selected sort order.</p>}
          </div>
        </article>

        <article className="analysis-card restriction-card">
          <header className="analysis-card-header">
            <div>
              <span className="analysis-number">02</span>
              <h4>Restriction sites</h4>
              <p>{RESTRICTION_ENZYMES.length} commonly used Type II and Type IIS enzymes.</p>
            </div>
            <div className="analysis-controls restriction-controls">
              <label>
                <span>Find enzyme</span>
                <input value={enzymeQuery} onChange={(event) => onPreferencesChange({ ...preferences, enzymeQuery: event.target.value })} placeholder="EcoRI or GAATTC" />
              </label>
              <label>
                <span>Show</span>
                <select value={cutterMode} onChange={(event) => onPreferencesChange({ ...preferences, cutterMode: event.target.value as CutterMode })}>
                  <option value="all">All cutters</option>
                  <option value="unique">Unique cutters</option>
                  <option value="double">Two cutters</option>
                  <option value="type-iis">Type IIS only</option>
                </select>
              </label>
            </div>
          </header>

          <div className="analysis-summary">
            <strong>{visibleSites.length}</strong><span>visible sites</span>
            {analysisPending && <span className="analysis-pending">Analyzing…</span>}
            <i className="summary-dot enzyme" /><span>{visibleEnzymeRows.length} enzymes cut</span>
            <span className="noncutter-count">{RESTRICTION_ENZYMES.length - enzymeRows.length} noncutters</span>
          </div>

          <div className="restriction-map" aria-label="Restriction-site map">
            <div className="analysis-scale"><span>1</span><span>{numberFormatter.format(Math.round(sequence.length / 2))}</span><span>{numberFormatter.format(sequence.length)} bp</span></div>
            <div className="restriction-rail">
              {visibleSites.map((site) => (
                <button
                  type="button"
                  className={`restriction-marker ${site.enzyme.kind === "Type IIS" ? "type-iis" : ""}`}
                  key={site.id}
                  style={{ left: `${((site.position - 1) / sequence.length) * 100}%` }}
                  title={`${site.enzyme.name} · ${site.enzyme.recognition} · ${site.position}${site.strand === "-" ? " · reverse" : ""}`}
                  aria-label={`Select ${site.enzyme.name} site at ${site.position}`}
                  onClick={() => onNavigate?.(site.position, site.end)}
                />
              ))}
            </div>
          </div>

          <div className="analysis-table-wrap enzyme-table-wrap">
            <table className="analysis-table enzyme-table">
              <thead><tr>
                <th>Digest</th>
                <SortableTableHeader label="Enzyme" active={restrictionSort.key === "enzyme"} direction={restrictionSort.direction} onSort={() => updateRestrictionSort("enzyme")} />
                <SortableTableHeader label="Recognition" active={restrictionSort.key === "recognition"} direction={restrictionSort.direction} onSort={() => updateRestrictionSort("recognition")} />
                <SortableTableHeader label="Sites" active={restrictionSort.key === "sites"} direction={restrictionSort.direction} onSort={() => updateRestrictionSort("sites", "desc")} />
                <SortableTableHeader label="Coordinates" active={restrictionSort.key === "coordinates"} direction={restrictionSort.direction} onSort={() => updateRestrictionSort("coordinates")} />
              </tr></thead>
              <tbody>
                {visibleEnzymeRows.slice(0, 24).map(({ enzyme, sites }) => (
                  <tr key={enzyme.name}>
                    <td><input className="digest-checkbox" type="checkbox" checked={selectedDigestEnzymes.includes(enzyme.name)} onChange={() => toggleDigestEnzyme(enzyme.name)} aria-label={`Include ${enzyme.name} in digest`} /></td>
                    <td><strong>{enzyme.name}</strong>{enzyme.kind === "Type IIS" && <span className="type-tag">IIS</span>}</td>
                    <td className="recognition-sequence">{enzyme.recognition}</td>
                    <td>{sites.length}</td>
                    <td className="coordinate-list">{sites.slice(0, 6).map(({ position, end }, index) => <button type="button" key={`${position}-${index}`} onClick={() => onNavigate?.(position, end)}>{numberFormatter.format(position)}</button>)}{sites.length > 6 ? ` +${sites.length - 6}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleEnzymeRows.length && <p className="analysis-empty">No cutting enzymes match this filter.</p>}
            {visibleEnzymeRows.length > 24 && <p className="table-note">Showing 24 of {visibleEnzymeRows.length} cutting enzymes.</p>}
          </div>

          <section className="digest-simulator" aria-labelledby="digest-heading">
            <div className="digest-heading">
              <div>
                <span className="analysis-number">03</span>
                <h5 id="digest-heading">Restriction digest</h5>
                <p>Select enzymes in the table above to simulate fragment sizes and a gel lane.</p>
              </div>
              {selectedDigestEnzymes.length > 0 && <button type="button" className="text-button" onClick={() => setSelectedDigestEnzymes([])}>Clear digest</button>}
            </div>

            {selectedDigestEnzymes.length ? (
              <>
                <div className="digest-chip-row">
                  {selectedDigestEnzymes.map((name) => <button type="button" key={name} onClick={() => toggleDigestEnzyme(name)}>{name}<span aria-hidden="true">×</span></button>)}
                </div>
                <div className="digest-output">
                  <div className="digest-gel-column">
                    <div className="digest-gel-label"><span>Wells</span><b>{circular ? "Circular" : "Linear"} digest</b></div>
                    <div className="digest-gel" role="img" aria-label={`Simulated gel lane with ${digest.fragments.length} DNA fragments`}>
                      <i className="gel-well" />
                      {digest.fragments.map((fragment) => (
                        <span
                          className="gel-band"
                          key={fragment.id}
                          style={{ top: `${gelPosition(fragment.length, sequence.length)}%`, opacity: Math.min(.95, .44 + fragment.length / sequence.length) }}
                          title={`${numberFormatter.format(fragment.length)} bp`}
                        />
                      ))}
                    </div>
                    <small>Migration is a logarithmic size estimate.</small>
                  </div>
                  <div className="digest-results">
                    <div className="digest-totals">
                      <span><strong>{digest.cuts.length}</strong> cut{digest.cuts.length === 1 ? "" : "s"}</span>
                      <span><strong>{digest.fragments.length}</strong> fragment{digest.fragments.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="digest-fragments">
                      {digest.fragments.slice(0, 30).map((fragment, index) => (
                        <div key={fragment.id}>
                          <span>#{index + 1}</span>
                          <strong>{numberFormatter.format(fragment.length)} bp</strong>
                          <small>{numberFormatter.format(fragment.start)}–{numberFormatter.format(fragment.end)}{fragment.wrapsOrigin ? " · crosses origin" : ""}</small>
                        </div>
                      ))}
                    </div>
                    {digest.fragments.length > 30 && <p className="table-note">Showing the 30 largest fragments.</p>}
                  </div>
                </div>
              </>
            ) : (
              <div className="digest-empty"><span>↳</span><p>Tick one or more cutting enzymes above to build a virtual digest.</p></div>
            )}
          </section>
        </article>
      </div>
    </section>
  );
}
