import type { Feature, FeatureSegment, Primer, PrimerBinding, PrimerBindingSite, Qualifier, SequenceSpan, Strand } from "./types";

export type FeatureLocationRow = {
  start: string;
  end: string;
  source: FeatureSegment[];
};

export type FeatureDraft = {
  id?: string | null;
  name: string;
  kind: string;
  color: string;
  strand: Strand;
  rows: FeatureLocationRow[];
  qualifiers: Qualifier[];
  readingFrame: string;
};

export type PrimerDraft = {
  id?: string | null;
  name: string;
  sequence: string;
  bindingLength: string;
  description: string;
  color: string;
  phosphorylated: boolean;
};

export type BuildResult<T> = { value: T | null; errors: string[]; warnings: string[] };

function integerCoordinate(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function featureRowsFromSegments(segments: FeatureSegment[], sequenceLength: number, circular: boolean): FeatureLocationRow[] {
  const rows: FeatureLocationRow[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (circular && segment.span.end === sequenceLength && next?.span.start === 0) {
      rows.push({ start: String(segment.span.start + 1), end: String(next.span.end), source: [segment, next] });
      index += 1;
    } else {
      rows.push({ start: String(segment.span.start + 1), end: String(segment.span.end), source: [segment] });
    }
  }
  return rows;
}

function segmentFromSource(source: FeatureSegment | undefined, span: SequenceSpan): FeatureSegment {
  return {
    span,
    color: source?.color ?? null,
    name: source?.name ?? null,
    kind: source?.kind ?? null,
  };
}

export function buildFeature(draft: FeatureDraft, sequenceLength: number, circular: boolean): BuildResult<Feature> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = draft.name.trim();
  const kind = draft.kind.trim();
  if (!name) errors.push("Enter a feature name.");
  if (!kind) errors.push("Enter a feature type.");
  if (!draft.rows.length) errors.push("Add at least one feature segment.");
  if (!/^#[0-9a-f]{6}$/i.test(draft.color)) errors.push("Choose a valid feature color.");

  const segments: FeatureSegment[] = [];
  for (const [index, row] of draft.rows.entries()) {
    const start = integerCoordinate(row.start);
    const end = integerCoordinate(row.end);
    if (start === null || end === null) {
      errors.push(`Segment ${index + 1} requires whole-number coordinates.`);
      continue;
    }
    if (start < 1 || start > sequenceLength || end < 1 || end > sequenceLength) {
      errors.push(`Segment ${index + 1} must stay within bases 1–${sequenceLength.toLocaleString()}.`);
      continue;
    }
    if (start <= end) {
      segments.push(segmentFromSource(row.source[0], { start: start - 1, end }));
    } else if (circular) {
      segments.push(segmentFromSource(row.source[0], { start: start - 1, end: sequenceLength }));
      segments.push(segmentFromSource(row.source[1] ?? row.source[0], { start: 0, end }));
    } else {
      errors.push(`Segment ${index + 1} starts after it ends; only circular DNA can cross the origin.`);
    }
  }

  const readingFrame = draft.kind.toLowerCase() === "cds" && draft.readingFrame
    ? Number(draft.readingFrame) - 1
    : null;
  if (readingFrame !== null && ![0, 1, 2].includes(readingFrame)) errors.push("Choose reading frame 1, 2, or 3.");
  const totalLength = segments.reduce((sum, segment) => sum + segment.span.end - segment.span.start, 0);
  if (draft.kind.toLowerCase() === "cds" && totalLength % 3 !== 0) warnings.push("CDS length is not divisible by three; verify its reading frame.");
  const sorted = [...segments].sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  if (sorted.some((segment, index) => index > 0 && segment.span.start < sorted[index - 1].span.end)) warnings.push("Feature segments overlap.");

  return {
    value: errors.length ? null : {
      id: draft.id ?? null,
      name,
      kind,
      color: draft.color,
      strand: draft.strand,
      segments,
      qualifiers: draft.qualifiers
        .map(({ name: qualifierName, value }) => ({ name: qualifierName.trim(), value: value.trim() }))
        .filter(({ name: qualifierName }) => qualifierName.length > 0),
      reading_frame: readingFrame,
    },
    errors,
    warnings,
  };
}

export function buildPrimer(draft: PrimerDraft, templateLength?: number): BuildResult<Primer> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = draft.name.trim();
  const sequence = draft.sequence.replace(/\s/g, "").toUpperCase();
  const bindingLength = integerCoordinate(draft.bindingLength);
  if (!name) errors.push("Enter a primer name.");
  if (!sequence) errors.push("Enter a primer sequence.");
  const unsupported = sequence.match(/[^ACGT]/)?.[0];
  if (unsupported) errors.push(`Primer sequence contains unsupported symbol “${unsupported}”.`);
  if (sequence.length > 500) errors.push("Primers are limited to 500 bases for safe interactive analysis.");
  if (bindingLength === null || bindingLength < 1 || bindingLength > sequence.length) errors.push(`Set a 3′ binding length between 1 and ${Math.max(sequence.length, 1)} bases.`);
  if (bindingLength !== null && templateLength !== undefined && bindingLength > templateLength) errors.push(`The 3′ binding region cannot be longer than the ${templateLength.toLocaleString()}-base template.`);
  if (!/^#[0-9a-f]{6}$/i.test(draft.color)) errors.push("Choose a valid primer color.");
  if (bindingLength !== null && sequence.length - bindingLength > 80) warnings.push("This primer has an unusually long 5′ tail; verify synthesis constraints.");

  return {
    value: errors.length ? null : {
      id: draft.id ?? null,
      name,
      sequence,
      binding_length: bindingLength,
      description: draft.description.trim() || null,
      color: draft.color,
      phosphorylated: draft.phosphorylated,
      binding_sites: [],
    },
    errors,
    warnings,
  };
}

export function bindingSitesFromBinding(binding: PrimerBinding, sequenceLength: number): PrimerBindingSite[] {
  const strand: Strand = binding.strand === "+" ? "forward" : "reverse";
  if (!binding.wrapsOrigin) return [{ span: binding.span, strand }];
  return [
    { span: { start: binding.span.start, end: sequenceLength }, strand },
    { span: { start: 0, end: binding.span.end }, strand },
  ].filter(({ span }) => span.end > span.start);
}

export function primerTailAndBinding(sequence: string, bindingLength: number | null) {
  const length = bindingLength ?? 0;
  return {
    tail: sequence.slice(0, Math.max(0, sequence.length - length)),
    binding: length > 0 ? sequence.slice(-length) : "",
  };
}
