import type { OpenReadingFrame } from "./sequence-analysis.ts";
import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export const ORF_ID_QUALIFIER = "dotdna_orf_id";

function orfSegments(orf: OpenReadingFrame, sequenceLength: number, color: string): SnapGeneSegment[] {
  const ranges = orf.wrapsOrigin
    ? [[orf.start, sequenceLength], [1, orf.end]]
    : [[orf.start, orf.end]];
  return ranges.map(([start, end]) => ({
    range: `${start}-${end}`,
    start,
    end,
    color,
    name: null,
    type: "standard",
  }));
}

export function createOrfCdsFeature(orf: OpenReadingFrame, sequenceLength: number): SnapGeneFeature {
  const color = orf.strand === "+" ? "#ff8a4c" : "#58c882";
  const segments = orfSegments(orf, sequenceLength, color);
  return {
    name: `Predicted CDS ${orf.frame > 0 ? "+" : ""}${orf.frame}`,
    type: "CDS",
    range: segments.map(({ range }) => range).join(", "),
    color,
    directionality: orf.strand === "+" ? 1 : 2,
    strand: orf.strand,
    segments,
    qualifiers: [
      { name: ORF_ID_QUALIFIER, value: orf.id },
      { name: "translation", value: orf.protein },
      { name: "note", value: `Predicted locally by DOTDNA in reading frame ${orf.frame > 0 ? "+" : ""}${orf.frame}` },
    ],
    readingFrame: Math.abs(orf.frame) - 1,
  };
}

export function featureMatchesOrf(feature: SnapGeneFeature, orf: OpenReadingFrame, sequenceLength: number) {
  const taggedOrf = feature.qualifiers.find(({ name }) => name === ORF_ID_QUALIFIER)?.value;
  if (taggedOrf === orf.id) return true;
  if (feature.type.toUpperCase() !== "CDS" || feature.strand !== orf.strand) return false;

  const expected = orfSegments(orf, sequenceLength, "").map(({ start, end }) => [start, end]);
  const actual = feature.segments
    .filter(({ start, end }) => start !== null && end !== null)
    .map(({ start, end }) => [start, end]);
  return actual.length === expected.length
    && actual.every(([start, end], index) => start === expected[index][0] && end === expected[index][1]);
}
