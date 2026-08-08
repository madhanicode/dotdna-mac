import { reverseComplement, translate } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";

export type PrimerAnalysis = {
  sequence: string;
  length: number;
  gcPercent: number;
  meltingTemperature: number;
  molecularWeight: number;
};

export type PrimerBinding = {
  start: number;
  end: number;
  strand: "+" | "-";
  wrapsOrigin: boolean;
};

export type PcrProduct = {
  sequence: string;
  start: number;
  end: number;
  length: number;
  gcPercent: number;
  wrapsOrigin: boolean;
  forwardBinding: PrimerBinding;
  reverseBinding: PrimerBinding;
};

function exactPositions(template: string, query: string, circular: boolean) {
  const extension = circular ? template.slice(0, Math.max(0, query.length - 1)) : "";
  const searchable = template + extension;
  const positions: number[] = [];
  let cursor = 0;
  while (cursor <= searchable.length - query.length) {
    const found = searchable.indexOf(query, cursor);
    if (found < 0) break;
    if (found < template.length) positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

export function analyzePrimer(value: string): PrimerAnalysis {
  const sequence = normalizeDnaSequence(value);
  if (!sequence || !/^[ACGT]+$/.test(sequence)) throw new Error("Primers currently require unambiguous A, C, G, and T bases.");
  const gc = sequence.match(/[GC]/g)?.length ?? 0;
  const at = sequence.length - gc;
  const meltingTemperature = sequence.length < 14
    ? 2 * at + 4 * gc
    : 64.9 + (41 * (gc - 16.4)) / sequence.length;
  return {
    sequence,
    length: sequence.length,
    gcPercent: (gc / sequence.length) * 100,
    meltingTemperature,
    molecularWeight: sequence.length * 303.7 - 61.96,
  };
}

export function findPrimerBindings(templateValue: string, primerValue: string, circular = false) {
  const template = normalizeDnaSequence(templateValue);
  const primer = analyzePrimer(primerValue).sequence;
  const reverse = reverseComplement(primer);
  const bindings: PrimerBinding[] = exactPositions(template, primer, circular).map((position) => ({
    start: position + 1,
    end: ((position + primer.length - 1) % template.length) + 1,
    strand: "+" as const,
    wrapsOrigin: position + primer.length > template.length,
  }));
  if (reverse !== primer) {
    bindings.push(...exactPositions(template, reverse, circular).map((position) => ({
      start: position + 1,
      end: ((position + primer.length - 1) % template.length) + 1,
      strand: "-" as const,
      wrapsOrigin: position + primer.length > template.length,
    })));
  }
  return bindings.sort((a, b) => a.start - b.start || a.strand.localeCompare(b.strand));
}

function gcPercent(sequence: string) {
  const canonical = sequence.match(/[ACGT]/g)?.length ?? 0;
  const gc = sequence.match(/[GC]/g)?.length ?? 0;
  return canonical ? (gc / canonical) * 100 : 0;
}

export function simulatePcr(templateValue: string, forwardPrimer: string, reversePrimer: string, circular = false): PcrProduct | null {
  const template = normalizeDnaSequence(templateValue);
  const forwardBindings = findPrimerBindings(template, forwardPrimer, circular).filter(({ strand }) => strand === "+");
  const reverseBindings = findPrimerBindings(template, reversePrimer, circular).filter(({ strand }) => strand === "-");
  const products: PcrProduct[] = [];

  for (const forward of forwardBindings) {
    for (const reverse of reverseBindings) {
      const forwardIndex = forward.start - 1;
      const reverseEndExclusive = reverse.start - 1 + analyzePrimer(reversePrimer).length;
      if (!circular && reverseEndExclusive <= forwardIndex) continue;
      const extendedEnd = circular && reverseEndExclusive <= forwardIndex ? reverseEndExclusive + template.length : reverseEndExclusive;
      const length = extendedEnd - forwardIndex;
      if (length <= 0 || length > template.length + Math.max(analyzePrimer(forwardPrimer).length, analyzePrimer(reversePrimer).length)) continue;
      const extendedTemplate = circular ? template + template : template;
      const productSequence = extendedTemplate.slice(forwardIndex, extendedEnd);
      products.push({
        sequence: productSequence,
        start: forward.start,
        end: ((extendedEnd - 1) % template.length) + 1,
        length: productSequence.length,
        gcPercent: gcPercent(productSequence),
        wrapsOrigin: extendedEnd > template.length,
        forwardBinding: forward,
        reverseBinding: reverse,
      });
    }
  }

  return products.sort((a, b) => a.length - b.length || a.start - b.start)[0] ?? null;
}

export function translateReadingFrame(sequenceValue: string, frame: 1 | 2 | 3 | -1 | -2 | -3) {
  const sequence = normalizeDnaSequence(sequenceValue);
  const strand = frame > 0 ? sequence : reverseComplement(sequence);
  return translate(strand.slice(Math.abs(frame) - 1));
}
