import type { SequenceSpan, Strand } from "./types";

export type SelectionSource = "feature" | "primer" | "restriction" | "find" | "orf";

export type SequenceSelection = {
  documentId: string;
  revision: number;
  source: SelectionSource;
  entityId: string;
  label: string;
  intervals: SequenceSpan[];
  strand: Strand;
  wrapsOrigin: boolean;
  revealToken: number;
  detail?: string;
  color?: string | null;
  cutPositions?: { top: number | null; bottom: number | null };
};

export type SequenceMatch = {
  start: number;
  intervals: SequenceSpan[];
  wrapsOrigin: boolean;
  strand: "forward" | "reverse";
};

const iupac: Record<string, number> = {
  A: 0b0001, C: 0b0010, G: 0b0100, T: 0b1000,
  R: 0b0101, Y: 0b1010, S: 0b0110, W: 0b1001,
  K: 0b1100, M: 0b0011, B: 0b1110, D: 0b1101,
  H: 0b1011, V: 0b0111, N: 0b1111,
};
const iupacComplements: Record<string, string> = { A: "T", C: "G", G: "C", T: "A", R: "Y", Y: "R", S: "S", W: "W", K: "M", M: "K", B: "V", D: "H", H: "D", V: "B", N: "N" };

export function canonicalIntervals(start: number, length: number, sequenceLength: number, circular: boolean): SequenceSpan[] {
  if (!Number.isInteger(start) || !Number.isInteger(length) || sequenceLength <= 0 || length <= 0) return [];
  if (!circular) {
    const boundedStart = Math.max(0, Math.min(start, sequenceLength));
    const boundedEnd = Math.max(boundedStart, Math.min(start + length, sequenceLength));
    return boundedEnd > boundedStart ? [{ start: boundedStart, end: boundedEnd }] : [];
  }
  const boundedLength = Math.min(length, sequenceLength);
  const normalizedStart = ((start % sequenceLength) + sequenceLength) % sequenceLength;
  const end = normalizedStart + boundedLength;
  if (end <= sequenceLength) return [{ start: normalizedStart, end }];
  return [{ start: normalizedStart, end: sequenceLength }, { start: 0, end: end - sequenceLength }];
}

export function normalizeIntervals(intervals: SequenceSpan[], sequenceLength: number): SequenceSpan[] {
  return intervals
    .map(({ start, end }) => ({ start: Math.max(0, Math.min(start, sequenceLength)), end: Math.max(0, Math.min(end, sequenceLength)) }))
    .filter(({ start, end }) => end > start);
}

export function intervalContains(intervals: SequenceSpan[], position: number) {
  return intervals.some(({ start, end }) => position >= start && position < end);
}

export function validateFindQuery(queryValue: string) {
  const query = queryValue.replace(/[\s\d]/g, "").toUpperCase().replaceAll("U", "T");
  const invalid = [...query].find((base) => !iupac[base]);
  return { query, error: invalid ? `“${invalid}” is not a supported DNA or IUPAC symbol.` : null };
}

export function findSequenceMatches(sequenceValue: string, queryValue: string, circular: boolean, maximumResults = Number.POSITIVE_INFINITY): SequenceMatch[] {
  const sequence = sequenceValue.toUpperCase().replaceAll("U", "T");
  const validation = validateFindQuery(queryValue);
  const query = validation.query;
  if (!sequence.length || !query.length || validation.error || (!circular && query.length > sequence.length) || query.length > sequence.length) return [];
  const matches: SequenceMatch[] = [];
  const scan = (orientedQuery: string, strand: "forward" | "reverse", orientationLimit = maximumResults) => {
    const initialCount = matches.length;
    const limit = circular ? sequence.length : sequence.length - orientedQuery.length + 1;
    for (let start = 0; start < limit; start += 1) {
      let matchesHere = true;
      for (let offset = 0; offset < orientedQuery.length; offset += 1) {
        const templateMask = iupac[sequence[(start + offset) % sequence.length]] ?? 0;
        if ((templateMask & iupac[orientedQuery[offset]]) === 0) {
          matchesHere = false;
          break;
        }
      }
      if (matchesHere) {
        const intervals = canonicalIntervals(start, orientedQuery.length, sequence.length, circular);
        matches.push({ start, intervals, wrapsOrigin: intervals.length > 1, strand });
        if (matches.length - initialCount >= orientationLimit || matches.length >= maximumResults) break;
      }
    }
  };
  const reverseQuery = [...query].reverse().map((base) => iupacComplements[base]).join("");
  const forwardLimit = reverseQuery === query ? maximumResults : Math.ceil(maximumResults / 2);
  scan(query, "forward", forwardLimit);
  if (reverseQuery !== query && matches.length < maximumResults) scan(reverseQuery, "reverse");
  return matches.sort((left, right) => left.start - right.start || Number(left.strand === "reverse") - Number(right.strand === "reverse"));
}

export function selectionLength(selection: SequenceSelection) {
  return selection.intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

export function displayIntervals(intervals: SequenceSpan[]) {
  return intervals.map(({ start, end }) => `${(start + 1).toLocaleString()}–${end.toLocaleString()}`).join(", ");
}
