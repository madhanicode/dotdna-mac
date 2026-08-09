import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export type RowAnnotation = {
  id: string;
  featureIndex: number | null;
  kind: "feature" | "primer" | "restriction" | "orf";
  name: string;
  color: string;
  strand: "+" | "-" | "both" | null;
  start: number;
  end: number;
  startOffset: number;
  endOffset: number;
  lane: number;
};

export type SequenceOverlay = {
  id: string;
  kind: "primer" | "restriction" | "orf";
  name: string;
  color: string;
  strand: "+" | "-" | "both" | null;
  start: number;
  end: number;
};

export type AnnotatedSequenceRow = {
  start: number;
  end: number;
  sequence: string;
  annotations: RowAnnotation[];
  laneCount: number;
};

function rangeSegment(range: string | null): SnapGeneSegment | null {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  return {
    range: match[0],
    start: Number(match[1]),
    end: Number(match[2]),
    color: null,
    name: null,
    type: null,
  };
}

export function featureIntervals(feature: SnapGeneFeature, sequenceLength: number) {
  const segments = feature.segments.length ? feature.segments : [rangeSegment(feature.range)].filter(Boolean) as SnapGeneSegment[];
  return segments.flatMap((segment) => {
    if (segment.start === null || segment.end === null) return [];
    const start = Math.max(1, Math.min(sequenceLength, segment.start));
    const end = Math.max(1, Math.min(sequenceLength, segment.end));
    if (end >= start) return [{ start, end, color: segment.color ?? feature.color ?? "#17b6c9" }];
    return [
      { start, end: sequenceLength, color: segment.color ?? feature.color ?? "#17b6c9" },
      { start: 1, end, color: segment.color ?? feature.color ?? "#17b6c9" },
    ];
  });
}

function overlayIntervals(overlay: SequenceOverlay, sequenceLength: number) {
  const start = Math.max(1, Math.min(sequenceLength, overlay.start));
  const end = Math.max(1, Math.min(sequenceLength, overlay.end));
  return end >= start ? [{ start, end }] : [{ start, end: sequenceLength }, { start: 1, end }];
}

export function buildAnnotatedSequenceRows(sequence: string, features: SnapGeneFeature[], lineWidth = 60, overlays: SequenceOverlay[] = []): AnnotatedSequenceRow[] {
  const width = Math.max(10, Math.floor(lineWidth));
  const rows: AnnotatedSequenceRow[] = [];
  for (let offset = 0; offset < sequence.length; offset += width) {
    const start = offset + 1;
    const end = Math.min(sequence.length, offset + width);
    const annotations: Omit<RowAnnotation, "lane">[] = [];

    features.forEach((feature, featureIndex) => {
      featureIntervals(feature, sequence.length).forEach((interval, segmentIndex) => {
        const overlapStart = Math.max(start, interval.start);
        const overlapEnd = Math.min(end, interval.end);
        if (overlapEnd < overlapStart) return;
        annotations.push({
          id: `${featureIndex}-${segmentIndex}-${start}`,
          featureIndex,
          kind: "feature",
          name: feature.name,
          color: interval.color,
          strand: feature.strand,
          start: overlapStart,
          end: overlapEnd,
          startOffset: overlapStart - start,
          endOffset: overlapEnd - start,
        });
      });
    });

    overlays.forEach((overlay) => {
      overlayIntervals(overlay, sequence.length).forEach((interval, segmentIndex) => {
        const overlapStart = Math.max(start, interval.start);
        const overlapEnd = Math.min(end, interval.end);
        if (overlapEnd < overlapStart) return;
        annotations.push({
          id: `${overlay.id}-${segmentIndex}-${start}`,
          featureIndex: null,
          kind: overlay.kind,
          name: overlay.name,
          color: overlay.color,
          strand: overlay.strand,
          start: overlapStart,
          end: overlapEnd,
          startOffset: overlapStart - start,
          endOffset: overlapEnd - start,
        });
      });
    });

    const laneEnds: number[] = [];
    const placed = annotations
      .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset || (a.featureIndex ?? Number.MAX_SAFE_INTEGER) - (b.featureIndex ?? Number.MAX_SAFE_INTEGER))
      .map((annotation): RowAnnotation => {
        let lane = laneEnds.findIndex((laneEnd) => annotation.startOffset > laneEnd);
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.push(annotation.endOffset);
        } else {
          laneEnds[lane] = annotation.endOffset;
        }
        return { ...annotation, lane };
      });

    rows.push({
      start,
      end,
      sequence: sequence.slice(offset, end),
      annotations: placed,
      laneCount: laneEnds.length,
    });
  }
  return rows;
}

export function featuresOverlappingRange(features: SnapGeneFeature[], sequenceLength: number, start: number, end: number) {
  return features.filter((feature) => featureIntervals(feature, sequenceLength).some((interval) => interval.start <= end && interval.end >= start));
}

export function motifBasePositions(sequence: string, motif: string) {
  const positions = new Set<number>();
  if (!motif) return positions;
  let cursor = 0;
  while (cursor <= sequence.length - motif.length) {
    const found = sequence.indexOf(motif, cursor);
    if (found < 0) break;
    for (let index = found + 1; index <= found + motif.length; index += 1) positions.add(index);
    cursor = found + 1;
  }
  return positions;
}
