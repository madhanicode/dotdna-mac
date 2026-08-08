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

export type PrimerDesignPurpose = "pcr" | "sequencing";

export type PrimerDesignCandidate = PrimerAnalysis & {
  name: string;
  start: number;
  end: number;
  strand: "+" | "-";
  bindingCount: number;
  score: number;
  warnings: string[];
};

export type PrimerDesignResult = {
  purpose: PrimerDesignPurpose;
  targetStart: number;
  targetEnd: number;
  forward: PrimerDesignCandidate;
  reverse: PrimerDesignCandidate;
  meltingTemperatureDifference: number;
  predictedAmpliconLength: number | null;
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
  bindings.push(...exactPositions(template, reverse, circular).map((position) => ({
    start: position + 1,
    end: ((position + primer.length - 1) % template.length) + 1,
    strand: "-" as const,
    wrapsOrigin: position + primer.length > template.length,
  })));
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

function candidateWarnings(analysis: PrimerAnalysis, bindingCount: number) {
  const warnings: string[] = [];
  if (bindingCount !== 1) warnings.push(bindingCount ? `${bindingCount} exact template bindings` : "No exact template binding");
  if (analysis.gcPercent < 35 || analysis.gcPercent > 65) warnings.push("GC outside 35–65%");
  if (analysis.meltingTemperature < 55 || analysis.meltingTemperature > 65) warnings.push("Tm outside 55–65°C");
  if (/(A{5}|C{5}|G{5}|T{5})/.test(analysis.sequence)) warnings.push("Homopolymer run ≥5 bases");
  if (!/[GC]$/.test(analysis.sequence)) warnings.push("Weak 3′ terminal base");
  return warnings;
}

function scoreCandidate(analysis: PrimerAnalysis, bindingCount: number, desiredTm: number) {
  const gcPenalty = analysis.gcPercent < 40
    ? 40 - analysis.gcPercent
    : analysis.gcPercent > 60 ? analysis.gcPercent - 60 : 0;
  const uniquenessPenalty = bindingCount === 1 ? 0 : bindingCount === 0 ? 90 : 35 + bindingCount * 3;
  const homopolymerPenalty = /(A{5}|C{5}|G{5}|T{5})/.test(analysis.sequence) ? 22 : 0;
  const terminalPenalty = /[GC]$/.test(analysis.sequence) ? 0 : 2;
  return Math.abs(analysis.meltingTemperature - desiredTm) * 2 + gcPenalty + uniquenessPenalty + homopolymerPenalty + terminalPenalty;
}

function makeDesignCandidate(
  template: string,
  startIndex: number,
  length: number,
  strand: "+" | "-",
  desiredTm: number,
  circular: boolean,
  name: string,
): PrimerDesignCandidate | null {
  if (startIndex < 0 || startIndex + length > template.length) return null;
  const bindingSequence = template.slice(startIndex, startIndex + length);
  const sequence = strand === "+" ? bindingSequence : reverseComplement(bindingSequence);
  try {
    const analysis = analyzePrimer(sequence);
    const bindingCount = findPrimerBindings(template, sequence, circular).length;
    return {
      ...analysis,
      name,
      start: startIndex + 1,
      end: startIndex + length,
      strand,
      bindingCount,
      score: scoreCandidate(analysis, bindingCount, desiredTm),
      warnings: candidateWarnings(analysis, bindingCount),
    };
  } catch {
    return null;
  }
}

export function designPrimerPair(
  templateValue: string,
  targetStartValue: number,
  targetEndValue: number,
  options: {
    purpose?: PrimerDesignPurpose;
    desiredTm?: number;
    minimumLength?: number;
    maximumLength?: number;
    searchWindow?: number;
    circular?: boolean;
  } = {},
): PrimerDesignResult {
  const template = normalizeDnaSequence(templateValue);
  const targetStart = Math.floor(targetStartValue);
  const targetEnd = Math.floor(targetEndValue);
  if (!template) throw new Error("A template sequence is required.");
  if (targetStart < 1 || targetEnd > template.length || targetEnd < targetStart) {
    throw new Error(`Choose a target interval between 1 and ${template.length.toLocaleString()} bp.`);
  }

  const purpose = options.purpose ?? "pcr";
  const desiredTm = Math.max(45, Math.min(75, options.desiredTm ?? 60));
  const minimumLength = Math.max(12, Math.floor(options.minimumLength ?? 18));
  const maximumLength = Math.max(minimumLength, Math.min(40, Math.floor(options.maximumLength ?? 25)));
  const searchWindow = Math.max(0, Math.min(100, Math.floor(options.searchWindow ?? 12)));
  const circular = Boolean(options.circular);
  const forwardCandidates: PrimerDesignCandidate[] = [];
  const reverseCandidates: PrimerDesignCandidate[] = [];

  for (let length = minimumLength; length <= maximumLength; length += 1) {
    if (purpose === "pcr") {
      for (let offset = -searchWindow; offset <= searchWindow; offset += 1) {
        const forward = makeDesignCandidate(template, targetStart - 1 + offset, length, "+", desiredTm, circular, "PCR forward");
        const reverse = makeDesignCandidate(template, targetEnd - length + offset, length, "-", desiredTm, circular, "PCR reverse");
        if (forward) forwardCandidates.push(forward);
        if (reverse) reverseCandidates.push(reverse);
      }
    } else {
      for (let gap = 0; gap <= searchWindow; gap += 1) {
        const forward = makeDesignCandidate(template, targetStart - 1 - gap - length, length, "+", desiredTm, circular, "Sequencing forward");
        const reverse = makeDesignCandidate(template, targetEnd + gap, length, "-", desiredTm, circular, "Sequencing reverse");
        if (forward) forwardCandidates.push(forward);
        if (reverse) reverseCandidates.push(reverse);
      }
    }
  }

  if (!forwardCandidates.length || !reverseCandidates.length) {
    const context = purpose === "sequencing" ? "Sequencing primers need enough flanking sequence on both sides of the target." : "The target is too close to a template boundary.";
    throw new Error(`${context} Adjust the target range or primer lengths.`);
  }

  const forwardPool = forwardCandidates.sort((a, b) => a.score - b.score || a.start - b.start).slice(0, 30);
  const reversePool = reverseCandidates.sort((a, b) => a.score - b.score || b.end - a.end).slice(0, 30);
  let best: { forward: PrimerDesignCandidate; reverse: PrimerDesignCandidate; score: number } | null = null;
  for (const forward of forwardPool) {
    for (const reverse of reversePool) {
      const tmDifference = Math.abs(forward.meltingTemperature - reverse.meltingTemperature);
      const geometryPenalty = purpose === "pcr" && forward.start >= reverse.end ? 1_000 : 0;
      const score = forward.score + reverse.score + tmDifference * 3 + geometryPenalty;
      if (!best || score < best.score) best = { forward, reverse, score };
    }
  }
  if (!best) throw new Error("No primer pair could be designed for that interval.");

  const product = purpose === "pcr"
    ? simulatePcr(template, best.forward.sequence, best.reverse.sequence, circular)
    : null;
  return {
    purpose,
    targetStart,
    targetEnd,
    forward: best.forward,
    reverse: best.reverse,
    meltingTemperatureDifference: Math.abs(best.forward.meltingTemperature - best.reverse.meltingTemperature),
    predictedAmpliconLength: product?.length ?? null,
  };
}

export function translateReadingFrame(sequenceValue: string, frame: 1 | 2 | 3 | -1 | -2 | -3) {
  const sequence = normalizeDnaSequence(sequenceValue);
  const strand = frame > 0 ? sequence : reverseComplement(sequence);
  return translate(strand.slice(Math.abs(frame) - 1));
}
