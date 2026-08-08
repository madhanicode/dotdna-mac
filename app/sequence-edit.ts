import { reverseComplement } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";
import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export type SequenceEdit =
  | { kind: "insert"; position: number; sequence: string }
  | { kind: "delete"; start: number; end: number }
  | { kind: "replace"; start: number; end: number; sequence: string }
  | { kind: "reverse-complement" };

export type SequenceEditResult = {
  sequence: string;
  features: SnapGeneFeature[];
  description: string;
};

function rebuildFeature(feature: SnapGeneFeature, segments: SnapGeneSegment[]): SnapGeneFeature | null {
  if (!segments.length) return null;
  return {
    ...feature,
    segments,
    range: segments.map(({ range }) => range).join(", "),
    color: segments.find(({ color }) => color)?.color ?? feature.color,
  };
}

function moveSegment(segment: SnapGeneSegment, start: number, end: number) {
  return { ...segment, start, end, range: `${start}-${end}` };
}

function insertIntoFeatures(features: SnapGeneFeature[], position: number, insertedLength: number) {
  return features.flatMap((feature) => {
    const segments = feature.segments.flatMap((segment) => {
      if (segment.start === null || segment.end === null) return [segment];
      if (segment.end < position) return [segment];
      if (segment.start >= position) return [moveSegment(segment, segment.start + insertedLength, segment.end + insertedLength)];
      return [moveSegment(segment, segment.start, segment.end + insertedLength)];
    });
    const rebuilt = rebuildFeature(feature, segments);
    return rebuilt ? [rebuilt] : [];
  });
}

function replaceInFeatures(features: SnapGeneFeature[], start: number, end: number, insertedLength: number) {
  const removedLength = end - start + 1;
  const delta = insertedLength - removedLength;
  return features.flatMap((feature) => {
    const segments = feature.segments.flatMap((segment) => {
      if (segment.start === null || segment.end === null) return [segment];
      if (segment.end < start) return [segment];
      if (segment.start > end) return [moveSegment(segment, segment.start + delta, segment.end + delta)];

      if (segment.start >= start && segment.end <= end) {
        return insertedLength > 0 ? [moveSegment(segment, start, start + insertedLength - 1)] : [];
      }

      const nextStart = segment.start < start ? segment.start : start;
      const nextEnd = segment.end > end
        ? segment.end + delta
        : insertedLength > 0 ? start + insertedLength - 1 : start - 1;
      return nextEnd >= nextStart ? [moveSegment(segment, nextStart, nextEnd)] : [];
    });
    const rebuilt = rebuildFeature(feature, segments);
    return rebuilt ? [rebuilt] : [];
  });
}

function reverseFeature(feature: SnapGeneFeature, length: number) {
  const segments = [...feature.segments].reverse().map((segment) => {
    if (segment.start === null || segment.end === null) return segment;
    const start = length - segment.end + 1;
    const end = length - segment.start + 1;
    return moveSegment(segment, start, end);
  });
  return {
    ...feature,
    directionality: feature.directionality === 1 ? 2 as const : feature.directionality === 2 ? 1 as const : feature.directionality,
    strand: feature.strand === "+" ? "-" as const : feature.strand === "-" ? "+" as const : feature.strand,
    segments,
    range: segments.map(({ range }) => range).join(", ") || feature.range,
  };
}

function checkRange(start: number, end: number, length: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > length) {
    throw new Error(`Use a coordinate range between 1 and ${length}.`);
  }
}

export function applySequenceEdit(sequence: string, features: SnapGeneFeature[], edit: SequenceEdit): SequenceEditResult {
  if (edit.kind === "reverse-complement") {
    return {
      sequence: reverseComplement(sequence),
      features: features.map((feature) => reverseFeature(feature, sequence.length)),
      description: "Reverse complemented the entire sequence",
    };
  }

  if (edit.kind === "insert") {
    if (!Number.isInteger(edit.position) || edit.position < 1 || edit.position > sequence.length + 1) {
      throw new Error(`Insert at a position between 1 and ${sequence.length + 1}.`);
    }
    const inserted = normalizeDnaSequence(edit.sequence);
    if (!inserted) throw new Error("Enter DNA bases to insert.");
    const offset = edit.position - 1;
    return {
      sequence: sequence.slice(0, offset) + inserted + sequence.slice(offset),
      features: insertIntoFeatures(features, edit.position, inserted.length),
      description: `Inserted ${inserted.length} bp at ${edit.position}`,
    };
  }

  checkRange(edit.start, edit.end, sequence.length);
  const inserted = edit.kind === "replace" ? normalizeDnaSequence(edit.sequence) : "";
  if (edit.kind === "replace" && !inserted) throw new Error("Enter replacement DNA bases.");
  const from = edit.start - 1;
  const nextSequence = sequence.slice(0, from) + inserted + sequence.slice(edit.end);
  return {
    sequence: nextSequence,
    features: replaceInFeatures(features, edit.start, edit.end, inserted.length),
    description: edit.kind === "delete"
      ? `Deleted ${edit.end - edit.start + 1} bp at ${edit.start}–${edit.end}`
      : `Replaced ${edit.start}–${edit.end} with ${inserted.length} bp`,
  };
}
