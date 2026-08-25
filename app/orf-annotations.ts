import type { OpenReadingFrame } from "./sequence-analysis.ts";
import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export const ORF_ID_QUALIFIER = "dotdna_orf_id";
export const DOTDNA_SOURCE_QUALIFIER = "dotdna_source";
export const DOTDNA_CHECKSUM_QUALIFIER = "dotdna_sequence_checksum";
export const ORF_PARAMETERS_QUALIFIER = "dotdna_orf_parameters";

export function sequenceChecksum(sequence: string) {
  let hash = 2166136261;
  for (const base of sequence.toUpperCase()) {
    hash ^= base.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${sequence.length}`;
}

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

export function createOrfCdsFeature(
  orf: OpenReadingFrame,
  sequenceLength: number,
  sequence = "",
  parameters: { minimumAminoAcids?: number; startMode?: string } = {},
): SnapGeneFeature {
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
      { name: DOTDNA_SOURCE_QUALIFIER, value: "orf-finder" },
      { name: ORF_ID_QUALIFIER, value: orf.id },
      ...(sequence ? [{ name: DOTDNA_CHECKSUM_QUALIFIER, value: sequenceChecksum(sequence) }] : []),
      { name: ORF_PARAMETERS_QUALIFIER, value: JSON.stringify(parameters) },
      { name: "translation", value: orf.protein },
      { name: "note", value: `Predicted locally by DOTDNA in reading frame ${orf.frame > 0 ? "+" : ""}${orf.frame}` },
    ],
    readingFrame: Math.abs(orf.frame) - 1,
  };
}

export function isOrfAnnotation(feature: SnapGeneFeature) {
  return feature.qualifiers.some(({ name, value }) => name === DOTDNA_SOURCE_QUALIFIER && value === "orf-finder")
    || feature.qualifiers.some(({ name }) => name === ORF_ID_QUALIFIER);
}

export function isOrfAnnotationStale(feature: SnapGeneFeature, sequence: string) {
  if (!isOrfAnnotation(feature)) return false;
  const checksum = feature.qualifiers.find(({ name }) => name === DOTDNA_CHECKSUM_QUALIFIER)?.value;
  return Boolean(checksum && checksum !== sequenceChecksum(sequence));
}

export function acknowledgeOrfAnnotation(feature: SnapGeneFeature, sequence: string) {
  return {
    ...feature,
    qualifiers: [
      ...feature.qualifiers.filter(({ name }) => name !== DOTDNA_CHECKSUM_QUALIFIER),
      { name: DOTDNA_CHECKSUM_QUALIFIER, value: sequenceChecksum(sequence) },
      { name: "note", value: "Prediction coordinates reviewed locally after a sequence edit." },
    ],
  };
}

export function detachOrfAnnotation(feature: SnapGeneFeature) {
  const provenanceNames = new Set([DOTDNA_SOURCE_QUALIFIER, DOTDNA_CHECKSUM_QUALIFIER, ORF_ID_QUALIFIER, ORF_PARAMETERS_QUALIFIER]);
  return { ...feature, qualifiers: feature.qualifiers.filter(({ name }) => !provenanceNames.has(name)) };
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
