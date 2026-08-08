import { reverseComplement } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";

export type AssemblyFragment = {
  name: string;
  sequence: string;
};

export type AssemblyJunction = {
  left: string;
  right: string;
  overlap: number;
  reverseComplemented: boolean;
  closure: boolean;
};

export type AssemblyResult = {
  sequence: string;
  circular: boolean;
  fragments: Array<AssemblyFragment & { reverseComplemented: boolean }>;
  junctions: AssemblyJunction[];
};

export type PairwiseAlignment = {
  alignedReference: string;
  alignedQuery: string;
  comparison: string;
  score: number;
  matches: number;
  mismatches: number;
  gaps: number;
  identityPercent: number;
  alignmentLength: number;
};

function cleanDna(value: string) {
  return normalizeDnaSequence(value).replaceAll("-", "");
}

function longestSuffixPrefix(left: string, right: string, minimum: number, maximum = Math.min(left.length, right.length)) {
  for (let size = maximum; size >= minimum; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return size;
  }
  return 0;
}

export function parseAssemblyFragments(value: string): AssemblyFragment[] {
  const source = value.trim();
  if (!source) throw new Error("Paste at least two DNA fragments.");

  const fragments: AssemblyFragment[] = [];
  if (source.startsWith(">")) {
    let currentName = "";
    let currentSequence = "";
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith(">")) {
        if (currentName) fragments.push({ name: currentName, sequence: cleanDna(currentSequence) });
        currentName = line.slice(1).trim() || `Fragment ${fragments.length + 1}`;
        currentSequence = "";
      } else {
        currentSequence += line;
      }
    }
    if (currentName) fragments.push({ name: currentName, sequence: cleanDna(currentSequence) });
  } else {
    for (const [index, block] of source.split(/\n\s*\n/).entries()) {
      fragments.push({ name: `Fragment ${index + 1}`, sequence: cleanDna(block) });
    }
  }

  if (fragments.length < 2) throw new Error("Provide at least two fragments, using FASTA records or blank lines between sequences.");
  if (fragments.length > 12) throw new Error("This preview accepts up to 12 fragments at a time.");
  if (fragments.some(({ sequence }) => !sequence)) throw new Error("Every fragment needs a DNA sequence.");
  return fragments;
}

export function assembleByExactOverlap(
  fragments: AssemblyFragment[],
  options: { minimumOverlap?: number; circular?: boolean } = {},
): AssemblyResult {
  const minimumOverlap = Math.max(1, Math.floor(options.minimumOverlap ?? 20));
  if (fragments.length < 2) throw new Error("Assembly requires at least two fragments.");

  const normalized = fragments.map((fragment, index) => ({
    name: fragment.name.trim() || `Fragment ${index + 1}`,
    sequence: cleanDna(fragment.sequence),
  }));
  if (normalized.some(({ sequence }) => !sequence)) throw new Error("Every fragment needs a DNA sequence.");

  const oriented: AssemblyResult["fragments"] = [{ ...normalized[0], reverseComplemented: false }];
  const junctions: AssemblyJunction[] = [];
  let product = normalized[0].sequence;

  for (let index = 1; index < normalized.length; index += 1) {
    const fragment = normalized[index];
    const reverse = reverseComplement(fragment.sequence);
    const directOverlap = longestSuffixPrefix(product, fragment.sequence, minimumOverlap);
    const reverseOverlap = longestSuffixPrefix(product, reverse, minimumOverlap);
    const useReverse = reverseOverlap > directOverlap;
    const overlap = useReverse ? reverseOverlap : directOverlap;
    if (!overlap) {
      throw new Error(`${oriented.at(-1)?.name ?? "The previous fragment"} and ${fragment.name} do not share an exact overlap of ${minimumOverlap} bp or longer in either orientation.`);
    }
    const sequence = useReverse ? reverse : fragment.sequence;
    product += sequence.slice(overlap);
    junctions.push({
      left: oriented.at(-1)?.name ?? `Fragment ${index}`,
      right: fragment.name,
      overlap,
      reverseComplemented: useReverse,
      closure: false,
    });
    oriented.push({ name: fragment.name, sequence, reverseComplemented: useReverse });
  }

  if (options.circular) {
    const first = oriented[0];
    const maximumClosure = Math.min(product.length - 1, first.sequence.length);
    const overlap = longestSuffixPrefix(product, first.sequence, minimumOverlap, maximumClosure);
    if (!overlap) throw new Error(`The final product does not close onto ${first.name} with an exact overlap of ${minimumOverlap} bp or longer.`);
    product = product.slice(0, -overlap);
    junctions.push({
      left: oriented.at(-1)?.name ?? "Final fragment",
      right: first.name,
      overlap,
      reverseComplemented: false,
      closure: true,
    });
  }

  return { sequence: product, circular: Boolean(options.circular), fragments: oriented, junctions };
}

export function alignDnaGlobal(
  referenceValue: string,
  queryValue: string,
  options: { match?: number; mismatch?: number; gap?: number; maximumCells?: number } = {},
): PairwiseAlignment {
  const reference = cleanDna(referenceValue);
  const query = cleanDna(queryValue);
  if (!reference || !query) throw new Error("Provide both a reference and a query sequence.");

  const rows = reference.length + 1;
  const columns = query.length + 1;
  const maximumCells = options.maximumCells ?? 4_000_000;
  if (rows * columns > maximumCells) {
    throw new Error("That comparison is too large for an in-browser global alignment. Select a reference region and keep the query near 2,000 bp or shorter.");
  }

  const matchScore = options.match ?? 2;
  const mismatchScore = options.mismatch ?? -1;
  const gapScore = options.gap ?? -2;
  const scores = new Int32Array(rows * columns);
  const trace = new Uint8Array(rows * columns);

  for (let row = 1; row < rows; row += 1) {
    const cell = row * columns;
    scores[cell] = row * gapScore;
    trace[cell] = 2;
  }
  for (let column = 1; column < columns; column += 1) {
    scores[column] = column * gapScore;
    trace[column] = 3;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cell = row * columns + column;
      const diagonal = scores[(row - 1) * columns + column - 1]
        + (reference[row - 1] === query[column - 1] ? matchScore : mismatchScore);
      const up = scores[(row - 1) * columns + column] + gapScore;
      const left = scores[row * columns + column - 1] + gapScore;
      if (diagonal >= up && diagonal >= left) {
        scores[cell] = diagonal;
        trace[cell] = 1;
      } else if (up >= left) {
        scores[cell] = up;
        trace[cell] = 2;
      } else {
        scores[cell] = left;
        trace[cell] = 3;
      }
    }
  }

  const alignedReference: string[] = [];
  const alignedQuery: string[] = [];
  let row = reference.length;
  let column = query.length;
  while (row > 0 || column > 0) {
    const direction = trace[row * columns + column];
    if (direction === 1) {
      alignedReference.push(reference[row - 1]);
      alignedQuery.push(query[column - 1]);
      row -= 1;
      column -= 1;
    } else if (direction === 2 || column === 0) {
      alignedReference.push(reference[row - 1]);
      alignedQuery.push("-");
      row -= 1;
    } else {
      alignedReference.push("-");
      alignedQuery.push(query[column - 1]);
      column -= 1;
    }
  }

  const referenceResult = alignedReference.reverse().join("");
  const queryResult = alignedQuery.reverse().join("");
  let matches = 0;
  let mismatches = 0;
  let gaps = 0;
  let comparison = "";
  for (let index = 0; index < referenceResult.length; index += 1) {
    if (referenceResult[index] === "-" || queryResult[index] === "-") {
      gaps += 1;
      comparison += " ";
    } else if (referenceResult[index] === queryResult[index]) {
      matches += 1;
      comparison += "|";
    } else {
      mismatches += 1;
      comparison += ".";
    }
  }

  return {
    alignedReference: referenceResult,
    alignedQuery: queryResult,
    comparison,
    score: scores[reference.length * columns + query.length],
    matches,
    mismatches,
    gaps,
    identityPercent: referenceResult.length ? (matches / referenceResult.length) * 100 : 0,
    alignmentLength: referenceResult.length,
  };
}

export function formatPairwiseAlignment(alignment: PairwiseAlignment, width = 80) {
  const blocks: string[] = [];
  for (let index = 0; index < alignment.alignmentLength; index += width) {
    blocks.push([
      `Reference  ${alignment.alignedReference.slice(index, index + width)}`,
      `           ${alignment.comparison.slice(index, index + width)}`,
      `Query      ${alignment.alignedQuery.slice(index, index + width)}`,
    ].join("\n"));
  }
  return blocks.join("\n\n");
}
