"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SnapGeneFeature, SnapGeneSegment } from "./snapgene";
import { useSequenceAnalysis } from "./useSequenceAnalysis";

type MapFeature = Pick<SnapGeneFeature, "name" | "range" | "color"> & Partial<Pick<SnapGeneFeature, "segments" | "strand">>;

type Props = {
  fileName: string;
  sequence: string;
  circular: boolean;
  features: MapFeature[];
  selectedRange?: { start: number; end: number } | null;
  onSelectRange?: (start: number, end: number) => void;
};

type EnzymeDisplay = "unique" | "double" | "none";

const numberFormatter = new Intl.NumberFormat("en-US");

function parseRange(range: string | null) {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  return match ? { range: match[0], start: Number(match[1]), end: Number(match[2]), color: null, name: null, type: null } : null;
}

function segmentsFor(feature: MapFeature): SnapGeneSegment[] {
  if (feature.segments?.length) return feature.segments.filter((segment) => segment.start !== null && segment.end !== null);
  const segment = parseRange(feature.range);
  return segment ? [segment] : [];
}

function positionAngle(position: number, length: number) {
  return -Math.PI / 2 + ((position - 1) / length) * Math.PI * 2;
}

function segmentMidpoint(start: number, end: number, length: number) {
  const span = end >= start ? end - start + 1 : length - start + end + 1;
  return ((start - 1 + span / 2) % length) + 1;
}

function displayRange(feature: MapFeature) {
  return feature.range ?? "No coordinates";
}

export function PlasmidMap({ fileName, sequence, circular, features, selectedRange, onSelectRange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enzymeDisplay, setEnzymeDisplay] = useState<EnzymeDisplay>("unique");
  const [selectedFeature, setSelectedFeature] = useState(0);
  const { restrictionSites: sites } = useSequenceAnalysis(sequence, { circular, includeOrfs: false });
  const enzymeRows = useMemo(() => {
    const grouped = new Map<string, typeof sites>();
    for (const site of sites) grouped.set(site.enzyme.name, [...(grouped.get(site.enzyme.name) ?? []), site]);
    return [...grouped.entries()]
      .map(([name, enzymeSites]) => ({ name, sites: enzymeSites }))
      .sort((a, b) => a.sites[0].position - b.sites[0].position || a.name.localeCompare(b.name));
  }, [sites]);
  const visibleEnzymes = useMemo(() => enzymeRows.filter(({ sites: enzymeSites }) => {
    if (enzymeDisplay === "none") return false;
    return enzymeDisplay === "unique" ? enzymeSites.length === 1 : enzymeSites.length <= 2;
  }), [enzymeRows, enzymeDisplay]);
  const activeFeature = features[selectedFeature] ?? null;

  function downloadMap() {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName.replace(/\.[^.]+$/, "")}_plasmid-map.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2 + 8;
    const ringRadius = 184;
    context.clearRect(0, 0, width, height);

    context.save();
    context.strokeStyle = "rgba(7, 24, 39, .14)";
    context.lineWidth = 18;
    context.beginPath();
    context.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
    context.stroke();

    for (let quarter = 0; quarter < 4; quarter += 1) {
      const angle = -Math.PI / 2 + quarter * Math.PI / 2;
      const inner = ringRadius - 15;
      const outer = ringRadius + 15;
      context.strokeStyle = "rgba(7, 24, 39, .35)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
      context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
      context.stroke();
      context.fillStyle = "rgba(7, 24, 39, .52)";
      context.font = "10px ui-monospace, monospace";
      context.textAlign = quarter === 1 ? "left" : quarter === 3 ? "right" : "center";
      context.textBaseline = quarter === 0 ? "bottom" : quarter === 2 ? "top" : "middle";
      const labelPosition = quarter === 0 ? 1 : Math.round(sequence.length * quarter / 4);
      context.fillText(numberFormatter.format(labelPosition), centerX + Math.cos(angle) * (outer + 9), centerY + Math.sin(angle) * (outer + 9));
    }

    features.forEach((feature, featureIndex) => {
      const isSelected = featureIndex === selectedFeature;
      const featureSegments = segmentsFor(feature);
      featureSegments.forEach((segment, segmentIndex) => {
        if (segment.start === null || segment.end === null) return;
        const radius = ringRadius + 1 + (featureIndex % 3) * 13;
        const drawArc = (start: number, end: number) => {
          context.strokeStyle = segment.color ?? feature.color ?? "#17b6c9";
          context.lineWidth = isSelected ? 13 : 9;
          context.lineCap = "butt";
          context.beginPath();
          context.arc(centerX, centerY, radius, positionAngle(start, sequence.length), positionAngle(end + 1, sequence.length));
          context.stroke();
        };
        if (segment.end >= segment.start) drawArc(segment.start, segment.end);
        else {
          drawArc(segment.start, sequence.length);
          drawArc(1, segment.end);
        }

        if (segmentIndex === 0) {
          const labelAngle = positionAngle(segmentMidpoint(segment.start, segment.end, sequence.length), sequence.length);
          const leaderInner = ringRadius + 26 + (featureIndex % 3) * 13;
          const leaderOuter = 242 + (featureIndex % 2) * 19;
          const x1 = centerX + Math.cos(labelAngle) * leaderInner;
          const y1 = centerY + Math.sin(labelAngle) * leaderInner;
          const x2 = centerX + Math.cos(labelAngle) * leaderOuter;
          const y2 = centerY + Math.sin(labelAngle) * leaderOuter;
          context.strokeStyle = isSelected ? "rgba(7, 24, 39, .72)" : "rgba(7, 24, 39, .24)";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
          context.fillStyle = isSelected ? "#071827" : "rgba(7, 24, 39, .64)";
          context.font = `${isSelected ? "700 " : ""}11px Arial, sans-serif`;
          context.textAlign = Math.cos(labelAngle) >= 0 ? "left" : "right";
          context.textBaseline = "middle";
          context.fillText(feature.name.slice(0, 24), x2 + (Math.cos(labelAngle) >= 0 ? 5 : -5), y2, 125);
        }
      });
    });

    visibleEnzymes.forEach(({ sites: enzymeSites }) => {
      enzymeSites.forEach((site) => {
        const angle = positionAngle(site.position, sequence.length);
        context.strokeStyle = site.enzyme.kind === "Type IIS" ? "#ff725e" : "#17b6c9";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(centerX + Math.cos(angle) * (ringRadius - 17), centerY + Math.sin(angle) * (ringRadius - 17));
        context.lineTo(centerX + Math.cos(angle) * (ringRadius + 12), centerY + Math.sin(angle) * (ringRadius + 12));
        context.stroke();
      });
    });

    context.fillStyle = "rgba(7, 24, 39, .48)";
    context.font = "700 10px ui-monospace, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(circular ? "CIRCULAR SOURCE" : "CIRCULAR MAP · LINEAR SOURCE", centerX, centerY - 32);
    context.fillStyle = "#071827";
    context.font = "26px Georgia, serif";
    context.fillText(activeFeature?.name.slice(0, 26) ?? fileName.replace(/\.dna$/i, "").slice(0, 26), centerX, centerY + 1, 260);
    context.fillStyle = "rgba(7, 24, 39, .58)";
    context.font = "11px ui-monospace, monospace";
    context.fillText(activeFeature ? displayRange(activeFeature) : `${numberFormatter.format(sequence.length)} bp`, centerX, centerY + 31);
    context.restore();
  }, [activeFeature, circular, features, fileName, selectedFeature, sequence.length, visibleEnzymes]);

  return (
    <section className="plasmid-section" id="map" aria-labelledby="plasmid-heading">
      <div className="plasmid-heading">
        <div>
          <span className="panel-kicker">INTERACTIVE MAP</span>
          <h3 id="plasmid-heading">The whole construct at a glance</h3>
        </div>
        <div className="map-controls" role="group" aria-label="Restriction enzymes on plasmid map">
          <span>Enzymes</span>
          <button type="button" className={enzymeDisplay === "unique" ? "active" : ""} onClick={() => setEnzymeDisplay("unique")}>Unique</button>
          <button type="button" className={enzymeDisplay === "double" ? "active" : ""} onClick={() => setEnzymeDisplay("double")}>1–2 cutters</button>
          <button type="button" className={enzymeDisplay === "none" ? "active" : ""} onClick={() => setEnzymeDisplay("none")}>Off</button>
          <button type="button" className="map-download" onClick={downloadMap}>PNG ↓</button>
        </div>
      </div>

      <div className="plasmid-layout">
        <div className="plasmid-canvas-wrap">
          <canvas ref={canvasRef} width="720" height="620" role="img" aria-label={`Circular plasmid map of ${fileName}, ${numberFormatter.format(sequence.length)} base pairs`} />
          <div className="map-key"><span><i className="map-key-feature" />Features</span><span><i className="map-key-enzyme" />Restriction sites</span><span><i className="map-key-iis" />Type IIS</span></div>
        </div>

        <aside className="map-inspector">
          <div className="map-inspector-block">
            <span className="map-inspector-label">FEATURES · {features.length}</span>
            {features.length ? (
              <div className="map-feature-buttons">
                {features.map((feature, index) => (
                  <button type="button" className={index === selectedFeature ? "active" : ""} key={`${feature.name}-${index}`} onClick={() => { setSelectedFeature(index); const segment = segmentsFor(feature)[0]; if (segment?.start !== null && segment?.end !== null) onSelectRange?.(segment.start, segment.end); }}>
                    <i style={{ backgroundColor: feature.color ?? "#17b6c9" }} />
                    <span><strong>{feature.name}</strong><small>{displayRange(feature)}</small></span>
                  </button>
                ))}
              </div>
            ) : <p>No mapped features yet.</p>}
          </div>
          <div className="map-inspector-block enzyme-list-block">
            <span className="map-inspector-label">VISIBLE ENZYMES · {visibleEnzymes.length}</span>
            {visibleEnzymes.length ? (
              <div className="map-enzyme-list">
                {visibleEnzymes.map(({ name, sites: enzymeSites }) => (
                  <button type="button" key={name} className={enzymeSites.some(({ position }) => selectedRange?.start === position) ? "active" : ""} onClick={() => onSelectRange?.(enzymeSites[0].position, enzymeSites[0].end)}><strong>{name}</strong><small>{enzymeSites.map(({ position }) => numberFormatter.format(position)).join(", ")}</small></button>
                ))}
              </div>
            ) : <p>Restriction markers are hidden.</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}
