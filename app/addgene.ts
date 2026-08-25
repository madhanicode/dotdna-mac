import { parseTextSequence } from "./sequence-formats.ts";
import { reverseComplement } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";
import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export const ADDGENE_SOURCE_QUALIFIER = "dotdna_source";
export const ADDGENE_ID_QUALIFIER = "addgene_plasmid_id";
export const ADDGENE_NAME_QUALIFIER = "addgene_plasmid_name";
export const ADDGENE_URL_QUALIFIER = "addgene_source_url";
export const ADDGENE_MATCH_QUALIFIER = "addgene_sequence_match";

export type AddgeneCatalogRecord = {
  id: string;
  name: string;
  sequence: string;
  features: SnapGeneFeature[];
  genbankText?: string;
  sourceUrl?: string;
};

export type SequenceTransform = {
  exact: true;
  orientation: "forward" | "reverse";
  offset: number;
  rotated: boolean;
};

export type AddgeneCandidate = {
  record: AddgeneCatalogRecord;
  similarity: number;
  transform: SequenceTransform | null;
  annotations: SnapGeneFeature[];
};

export type AddgeneApiResult = {
  plasmidId: string;
  plasmidName: string;
  sourceUrl: string;
  genbankText: string;
};

function textField(object: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function validFeatures(value: unknown): SnapGeneFeature[] {
  if (!Array.isArray(value)) return [];
  return value.filter((feature): feature is SnapGeneFeature => Boolean(feature)
    && typeof feature === "object"
    && typeof (feature as SnapGeneFeature).name === "string"
    && typeof (feature as SnapGeneFeature).type === "string"
    && Array.isArray((feature as SnapGeneFeature).segments)
    && Array.isArray((feature as SnapGeneFeature).qualifiers));
}

function candidateSequence(object: Record<string, unknown>) {
  const raw = textField(object, ["sequence", "full_sequence", "fullSequence", "bases", "dna_sequence", "dnaSequence"]);
  if (!raw) return "";
  try { return normalizeDnaSequence(raw); } catch { return ""; }
}

export function extractAddgeneCatalogRecords(value: unknown): AddgeneCatalogRecord[] {
  const records: AddgeneCatalogRecord[] = [];
  const fingerprints = new Set<string>();

  function visit(node: unknown, context: { id: string; name: string; sourceUrl: string }) {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, context));
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const id = textField(object, ["addgene_id", "addgeneId", "plasmid_id", "plasmidId", "catalog_number", "catalogNumber"]) || context.id;
    const name = textField(object, ["plasmid_name", "plasmidName", "display_name", "displayName", "name", "title"]) || context.name || (id ? `Addgene #${id}` : "Addgene sequence");
    const sourceUrl = textField(object, ["url", "source_url", "sourceUrl", "addgene_url", "addgeneUrl"]) || context.sourceUrl;
    const genbankText = textField(object, ["genbank", "genbank_text", "genbankText", "genbank_file", "genbankFile"]);
    let sequence = candidateSequence(object);
    let features = validFeatures(object.features ?? object.annotations);

    if (genbankText && /^LOCUS\s/m.test(genbankText)) {
      try {
        const parsed = parseTextSequence(`${id || "addgene"}.gb`, genbankText).data;
        sequence ||= parsed.sequence;
        features = parsed.features;
      } catch { /* Keep any structured sequence and features in this record. */ }
    }

    if (sequence.length >= 20) {
      const fingerprint = `${id}\u0000${sequence}`;
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        records.push({ id, name, sequence, features, ...(genbankText ? { genbankText } : {}), ...(sourceUrl ? { sourceUrl } : {}) });
      }
    }

    const nextContext = { id, name, sourceUrl };
    Object.values(object).forEach((child) => {
      if (child && typeof child === "object") visit(child, nextContext);
    });
  }

  visit(value, { id: "", name: "", sourceUrl: "" });
  return records;
}

export function parseAddgeneCatalog(text: string) {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error("Choose a valid Addgene JSON catalog or API export."); }
  const records = extractAddgeneCatalogRecords(value);
  if (!records.length) throw new Error("No DNA sequences were found in that Addgene catalog file.");
  return records;
}

export function matchSequence(targetValue: string, sourceValue: string, circular: boolean): SequenceTransform | null {
  const target = normalizeDnaSequence(targetValue);
  const source = normalizeDnaSequence(sourceValue);
  if (target.length !== source.length || !target.length) return null;
  const orientations: Array<["forward" | "reverse", string]> = [["forward", source], ["reverse", reverseComplement(source)]];
  for (const [orientation, oriented] of orientations) {
    const offset = circular ? (oriented + oriented).slice(0, oriented.length * 2 - 1).indexOf(target) : (oriented === target ? 0 : -1);
    if (offset >= 0 && offset < oriented.length) return { exact: true, orientation, offset, rotated: offset !== 0 };
  }
  return null;
}

function sampledKmers(sequence: string, size = 17, maximum = 2500) {
  const result = new Set<string>();
  if (sequence.length < size) return result;
  const stride = Math.max(1, Math.floor((sequence.length - size + 1) / maximum));
  for (let index = 0; index <= sequence.length - size; index += stride) result.add(sequence.slice(index, index + size));
  return result;
}

export function sequenceSimilarity(leftValue: string, rightValue: string) {
  const left = normalizeDnaSequence(leftValue);
  const right = normalizeDnaSequence(rightValue);
  if (!left.length || !right.length) return 0;
  const lengthScore = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const leftKmers = sampledKmers(left);
  const rightKmers = sampledKmers(right);
  if (!leftKmers.size || !rightKmers.size) return left === right ? 1 : 0;
  let shared = 0;
  leftKmers.forEach((kmer) => { if (rightKmers.has(kmer)) shared += 1; });
  return lengthScore * ((2 * shared) / (leftKmers.size + rightKmers.size));
}

function mappedPosition(sourceIndex: number, length: number, transform: SequenceTransform) {
  const orientedIndex = transform.orientation === "forward" ? sourceIndex : length - 1 - sourceIndex;
  return (orientedIndex - transform.offset + length) % length;
}

function mapSegment(segment: SnapGeneSegment, length: number, transform: SequenceTransform) {
  if (!segment.start || !segment.end) return [];
  const positions: number[] = [];
  for (let sourceIndex = segment.start - 1; sourceIndex < segment.end; sourceIndex += 1) {
    positions.push(mappedPosition(sourceIndex, length, transform));
  }
  positions.sort((left, right) => left - right);
  const groups: Array<{ start: number; end: number }> = [];
  for (const position of positions) {
    const previous = groups.at(-1);
    if (previous && position === previous.end + 1) previous.end = position;
    else groups.push({ start: position, end: position });
  }
  return groups.map(({ start, end }): SnapGeneSegment => ({
    ...segment,
    start: start + 1,
    end: end + 1,
    range: `${start + 1}-${end + 1}`,
  }));
}

function provenance(feature: SnapGeneFeature, record: AddgeneCatalogRecord, transform: SequenceTransform) {
  const names = new Set([ADDGENE_SOURCE_QUALIFIER, ADDGENE_ID_QUALIFIER, ADDGENE_NAME_QUALIFIER, ADDGENE_URL_QUALIFIER, ADDGENE_MATCH_QUALIFIER]);
  const match = `${transform.orientation}${transform.rotated ? ` rotation ${transform.offset} bp` : ""}`;
  return [
    ...feature.qualifiers.filter(({ name }) => !names.has(name)),
    { name: ADDGENE_SOURCE_QUALIFIER, value: "Addgene" },
    { name: ADDGENE_ID_QUALIFIER, value: record.id || "unknown" },
    { name: ADDGENE_NAME_QUALIFIER, value: record.name },
    ...(record.sourceUrl ? [{ name: ADDGENE_URL_QUALIFIER, value: record.sourceUrl }] : []),
    { name: ADDGENE_MATCH_QUALIFIER, value: match },
  ];
}

export function transferAddgeneAnnotations(record: AddgeneCatalogRecord, targetSequence: string, circular: boolean, transform = matchSequence(targetSequence, record.sequence, circular)) {
  if (!transform) return [];
  const length = normalizeDnaSequence(record.sequence).length;
  return record.features.map((feature) => {
    const segments = feature.segments.flatMap((segment) => mapSegment(segment, length, transform));
    const strand = transform.orientation === "reverse" ? (feature.strand === "+" ? "-" : feature.strand === "-" ? "+" : feature.strand) : feature.strand;
    const directionality = transform.orientation === "reverse" ? (feature.directionality === 1 ? 2 : feature.directionality === 2 ? 1 : feature.directionality) : feature.directionality;
    return {
      ...feature,
      range: segments.map(({ range }) => range).join(", ") || feature.range,
      segments,
      strand,
      directionality,
      qualifiers: provenance(feature, record, transform),
    } as SnapGeneFeature;
  });
}

export function findAddgeneCandidates(records: AddgeneCatalogRecord[], targetSequence: string, circular: boolean, limit = 8): AddgeneCandidate[] {
  return records.map((record) => {
    const transform = matchSequence(targetSequence, record.sequence, circular);
    const similarity = transform ? 1 : Math.max(sequenceSimilarity(targetSequence, record.sequence), sequenceSimilarity(targetSequence, reverseComplement(record.sequence)));
    return { record, transform, similarity, annotations: transform ? transferAddgeneAnnotations(record, targetSequence, circular, transform) : [] };
  }).filter(({ similarity }) => similarity >= 0.2)
    .sort((left, right) => right.similarity - left.similarity || right.record.features.length - left.record.features.length)
    .slice(0, limit);
}

export function apiResultToCandidate(result: AddgeneApiResult, targetSequence: string, circular: boolean): AddgeneCandidate {
  const parsed = parseTextSequence(`Addgene-${result.plasmidId}.gb`, result.genbankText).data;
  const record: AddgeneCatalogRecord = {
    id: result.plasmidId,
    name: result.plasmidName || `Addgene #${result.plasmidId}`,
    sequence: parsed.sequence,
    features: parsed.features,
    genbankText: result.genbankText,
    sourceUrl: result.sourceUrl,
  };
  const transform = matchSequence(targetSequence, record.sequence, circular);
  return {
    record,
    transform,
    similarity: transform ? 1 : Math.max(sequenceSimilarity(targetSequence, record.sequence), sequenceSimilarity(targetSequence, reverseComplement(record.sequence))),
    annotations: transform ? transferAddgeneAnnotations(record, targetSequence, circular, transform) : [],
  };
}
