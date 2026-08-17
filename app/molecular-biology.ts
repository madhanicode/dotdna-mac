import { reverseComplement, translate } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";

export type ThermodynamicConditions = {
  monovalentMolar: number;
  divalentMolar: number;
  dntpMolar: number;
  primerMolar: number;
};

export type PrimerAnalysisOptions = {
  bindingLength?: number;
  conditions?: Partial<ThermodynamicConditions>;
};

export type PrimerAnalysis = {
  sequence: string;
  length: number;
  gcPercent: number;
  fullGcPercent: number;
  meltingTemperature: number;
  molecularWeight: number;
  bindingSequence: string;
  bindingLength: number;
  tailSequence: string;
  tailLength: number;
  enthalpy: number;
  entropy: number;
  hairpinScore: number;
  selfDimerScore: number;
};

export type PrimerMismatch = {
  primerIndex: number;
  primerBase: string;
  templateBase: string;
};

export type PrimerBinding = {
  start: number;
  end: number;
  strand: "+" | "-";
  wrapsOrigin: boolean;
  bindingLength: number;
  tailLength: number;
  bindingSequence: string;
  tailSequence: string;
  templateSequence: string;
  mismatchCount: number;
  mismatches: PrimerMismatch[];
  threePrimeMatchLength: number;
  meltingTemperature: number;
};

export type PrimerBindingOptions = {
  bindingLength?: number;
  minimumBindingLength?: number;
  minimumThreePrimeMatch?: number;
  maximumMismatches?: number;
  maximumMismatchFraction?: number;
  conditions?: Partial<ThermodynamicConditions>;
};

export type PcrProductFeature = {
  name: string;
  type: "primer" | "tail" | "mutation" | "overlap";
  start: number;
  end: number;
  strand: "+" | "-" | "both";
  note?: string;
};

export type PcrProduct = {
  mode: "standard" | "inverse" | "overlap-extension";
  sequence: string;
  start: number;
  end: number;
  length: number;
  gcPercent: number;
  wrapsOrigin: boolean;
  forwardBinding: PrimerBinding;
  reverseBinding: PrimerBinding;
  features: PcrProductFeature[];
  warnings: string[];
  overlapLength?: number;
  fragments?: [PcrProduct, PcrProduct];
};

export type PcrSimulationOptions = {
  forwardBindingLength?: number;
  reverseBindingLength?: number;
  minimumThreePrimeMatch?: number;
  maximumMismatches?: number;
};

export type OverlapExtensionOptions = PcrSimulationOptions & {
  internalReverseBindingLength?: number;
  internalForwardBindingLength?: number;
  minimumOverlap?: number;
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
  warnings: string[];
};

const defaultConditions: ThermodynamicConditions = {
  monovalentMolar: 0.05,
  divalentMolar: 0.0015,
  dntpMolar: 0.0002,
  primerMolar: 0.00000025,
};

// SantaLucia 1998 nearest-neighbor parameters: [delta H kcal/mol, delta S cal/(K mol)].
const nearestNeighbor: Record<string, [number, number]> = {
  AA: [-7.9, -22.2], TT: [-7.9, -22.2], AT: [-7.2, -20.4], TA: [-7.2, -21.3],
  CA: [-8.5, -22.7], TG: [-8.5, -22.7], GT: [-8.4, -22.4], AC: [-8.4, -22.4],
  CT: [-7.8, -21.0], AG: [-7.8, -21.0], GA: [-8.2, -22.2], TC: [-8.2, -22.2],
  CG: [-10.6, -27.2], GC: [-9.8, -24.4], GG: [-8.0, -19.9], CC: [-8.0, -19.9],
};

function sequenceGcPercent(sequence: string) {
  if (!sequence.length) return 0;
  const gc = sequence.match(/[GC]/g)?.length ?? 0;
  return (gc / sequence.length) * 100;
}

function isSelfComplementary(sequence: string) {
  return sequence === reverseComplement(sequence);
}

function nearestNeighborTm(sequence: string, conditionOverrides: Partial<ThermodynamicConditions> = {}) {
  const conditions = { ...defaultConditions, ...conditionOverrides };
  if (sequence.length < 14) {
    const gc = sequence.match(/[GC]/g)?.length ?? 0;
    return { meltingTemperature: 2 * (sequence.length - gc) + 4 * gc, enthalpy: 0, entropy: 0 };
  }

  let enthalpy = 0.2;
  let entropy = -5.7;
  for (let index = 0; index < sequence.length - 1; index += 1) {
    const parameters = nearestNeighbor[sequence.slice(index, index + 2)];
    enthalpy += parameters[0];
    entropy += parameters[1];
  }
  for (const terminal of [sequence[0], sequence.at(-1)]) {
    if (terminal && /[AT]/.test(terminal)) {
      enthalpy += 2.2;
      entropy += 6.9;
    }
  }
  const selfComplementary = isSelfComplementary(sequence);
  if (selfComplementary) entropy -= 1.4;
  const availableMagnesium = Math.max(0, conditions.divalentMolar - conditions.dntpMolar);
  const saltEquivalent = Math.max(0.0001, conditions.monovalentMolar + 4 * Math.sqrt(availableMagnesium));
  const concentrationDivisor = selfComplementary ? 1 : 4;
  const meltingTemperature = (enthalpy * 1000)
    / (entropy + 1.987 * Math.log(Math.max(1e-12, conditions.primerMolar / concentrationDivisor)))
    - 273.15 + 16.6 * Math.log10(saltEquivalent);
  return { meltingTemperature, enthalpy, entropy };
}

function longestComplementaryRun(left: string, right: string) {
  const complement = reverseComplement(right);
  let longest = 0;
  for (let offset = -complement.length + 1; offset < left.length; offset += 1) {
    let run = 0;
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const rightIndex = leftIndex - offset;
      if (rightIndex >= 0 && rightIndex < complement.length && left[leftIndex] === complement[rightIndex]) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }
  }
  return longest;
}

function hairpinScore(sequence: string) {
  let longest = 0;
  for (let leftEnd = 3; leftEnd <= sequence.length - 4; leftEnd += 1) {
    for (let rightStart = leftEnd + 3; rightStart < sequence.length; rightStart += 1) {
      longest = Math.max(longest, longestComplementaryRun(sequence.slice(0, leftEnd), sequence.slice(rightStart)));
    }
  }
  return longest;
}

export function analyzePrimer(value: string, options: PrimerAnalysisOptions = {}): PrimerAnalysis {
  const sequence = normalizeDnaSequence(value);
  if (!sequence || !/^[ACGT]+$/.test(sequence)) throw new Error("Primers require unambiguous A, C, G, and T bases.");
  const requestedBindingLength = options.bindingLength ?? sequence.length;
  if (!Number.isInteger(requestedBindingLength) || requestedBindingLength < 1 || requestedBindingLength > sequence.length) {
    throw new Error(`The 3′ template-binding region must be between 1 and ${sequence.length} bases.`);
  }
  const bindingLength = requestedBindingLength;
  const tailLength = sequence.length - bindingLength;
  const bindingSequence = sequence.slice(tailLength);
  const thermodynamics = nearestNeighborTm(bindingSequence, options.conditions);
  return {
    sequence,
    length: sequence.length,
    gcPercent: sequenceGcPercent(bindingSequence),
    fullGcPercent: sequenceGcPercent(sequence),
    meltingTemperature: thermodynamics.meltingTemperature,
    molecularWeight: sequence.length * 303.7 - 61.96,
    bindingSequence,
    bindingLength,
    tailSequence: sequence.slice(0, tailLength),
    tailLength,
    enthalpy: thermodynamics.enthalpy,
    entropy: thermodynamics.entropy,
    hairpinScore: hairpinScore(sequence),
    selfDimerScore: longestComplementaryRun(sequence, sequence),
  };
}

function circularSlice(template: string, start: number, length: number) {
  if (!template.length || length <= 0) return "";
  let result = "";
  for (let offset = 0; offset < length; offset += 1) result += template[(start + offset) % template.length];
  return result;
}

function bindingAt(
  template: string,
  primer: string,
  startIndex: number,
  length: number,
  strand: "+" | "-",
  circular: boolean,
  options: PrimerBindingOptions,
): PrimerBinding | null {
  if (!circular && startIndex + length > template.length) return null;
  const templateSegment = circular
    ? circularSlice(template, startIndex, length)
    : template.slice(startIndex, startIndex + length);
  const bindingSequence = primer.slice(-length);
  const orientedTemplate = strand === "+" ? templateSegment : reverseComplement(templateSegment);
  const mismatches: PrimerMismatch[] = [];
  let threePrimeMatchLength = 0;
  for (let index = length - 1; index >= 0; index -= 1) {
    if (bindingSequence[index] === orientedTemplate[index]) {
      if (index === length - 1 - threePrimeMatchLength) threePrimeMatchLength += 1;
    } else {
      mismatches.push({
        primerIndex: primer.length - length + index + 1,
        primerBase: bindingSequence[index],
        templateBase: orientedTemplate[index],
      });
    }
  }
  mismatches.reverse();
  const minimumThreePrimeMatch = Math.min(length, options.minimumThreePrimeMatch ?? Math.min(8, length));
  const maximumMismatches = options.maximumMismatches ?? Math.max(1, Math.floor(length * 0.15));
  const maximumMismatchFraction = options.maximumMismatchFraction ?? 0.2;
  if (threePrimeMatchLength < minimumThreePrimeMatch
    || mismatches.length > maximumMismatches
    || mismatches.length / length > maximumMismatchFraction) return null;
  const baseTm = nearestNeighborTm(bindingSequence, options.conditions).meltingTemperature;
  const mismatchPenalty = mismatches.reduce((penalty, mismatch) => {
    const distanceFromThreePrime = primer.length - mismatch.primerIndex;
    return penalty + (distanceFromThreePrime < 5 ? 8 : distanceFromThreePrime < 10 ? 6 : 4);
  }, 0);
  return {
    start: startIndex + 1,
    end: ((startIndex + length - 1) % template.length) + 1,
    strand,
    wrapsOrigin: startIndex + length > template.length,
    bindingLength: length,
    tailLength: primer.length - length,
    bindingSequence,
    tailSequence: primer.slice(0, -length),
    templateSequence: orientedTemplate,
    mismatchCount: mismatches.length,
    mismatches,
    threePrimeMatchLength,
    meltingTemperature: baseTm - mismatchPenalty,
  };
}

function bindingPreference(binding: PrimerBinding) {
  // A mismatch is more disruptive than gaining one extra paired base. This also keeps
  // non-hybridizing 5′ tails out of an inferred binding region.
  return binding.bindingLength - binding.mismatchCount * 4;
}

export function findPrimerBindings(
  templateValue: string,
  primerValue: string,
  circular = false,
  options: PrimerBindingOptions = {},
) {
  const template = normalizeDnaSequence(templateValue);
  const primer = analyzePrimer(primerValue).sequence;
  if (!template) return [];
  const explicitLength = options.bindingLength;
  if (explicitLength !== undefined && (!Number.isInteger(explicitLength) || explicitLength < 1 || explicitLength > primer.length)) {
    throw new Error(`The 3′ template-binding region must be between 1 and ${primer.length} bases.`);
  }
  const minimumBindingLength = explicitLength
    ?? Math.min(primer.length, Math.max(12, Math.floor(options.minimumBindingLength ?? 12)));
  const maximumBindingLength = explicitLength ?? primer.length;
  const bestByAnchor = new Map<string, PrimerBinding>();

  for (let length = maximumBindingLength; length >= minimumBindingLength; length -= 1) {
    const lastStart = circular ? template.length - 1 : template.length - length;
    for (let startIndex = 0; startIndex <= lastStart; startIndex += 1) {
      for (const strand of ["+", "-"] as const) {
        const binding = bindingAt(template, primer, startIndex, length, strand, circular, options);
        if (!binding) continue;
        const anchor = strand === "+"
          ? `${strand}:${(startIndex + length - 1) % template.length}`
          : `${strand}:${startIndex}`;
        const current = bestByAnchor.get(anchor);
        if (!current || bindingPreference(binding) > bindingPreference(current)
          || (bindingPreference(binding) === bindingPreference(current) && binding.bindingLength > current.bindingLength)) {
          bestByAnchor.set(anchor, binding);
        }
      }
    }
  }

  return [...bestByAnchor.values()].sort((a, b) => a.start - b.start || a.strand.localeCompare(b.strand));
}

function gcPercent(sequence: string) {
  const canonical = sequence.match(/[ACGT]/g)?.length ?? 0;
  const gc = sequence.match(/[GC]/g)?.length ?? 0;
  return canonical ? (gc / canonical) * 100 : 0;
}

function bindingWarnings(binding: PrimerBinding, label: string) {
  const warnings: string[] = [];
  if (binding.mismatchCount) warnings.push(`${label} has ${binding.mismatchCount} intentional mismatch${binding.mismatchCount === 1 ? "" : "es"}; verify the encoded product sequence.`);
  if (binding.meltingTemperature < 50) warnings.push(`${label} annealing Tm is ${binding.meltingTemperature.toFixed(1)}°C; lengthen its 3′ binding region or lower the annealing temperature.`);
  if (binding.threePrimeMatchLength < 10) warnings.push(`${label} has only ${binding.threePrimeMatchLength} exact bases at its 3′ end; extend the exact 3′ match for reliable extension.`);
  return warnings;
}

function primerFeatures(
  primer: string,
  binding: PrimerBinding,
  productStart: number,
  productLength: number,
  strand: "+" | "-",
  label: string,
) {
  const primerStart = strand === "+" ? productStart : productStart - primer.length + 1;
  const primerEnd = strand === "+" ? productStart + primer.length - 1 : productStart;
  const features: PcrProductFeature[] = [{ name: `${label} primer`, type: "primer", start: primerStart, end: primerEnd, strand }];
  if (binding.tailLength) {
    const tailStart = strand === "+" ? primerStart : primerEnd - binding.tailLength + 1;
    const tailEnd = strand === "+" ? primerStart + binding.tailLength - 1 : primerEnd;
    features.push({ name: `${label} 5′ tail`, type: "tail", start: tailStart, end: tailEnd, strand });
  }
  for (const mismatch of binding.mismatches) {
    const position = strand === "+"
      ? primerStart + mismatch.primerIndex - 1
      : primerEnd - mismatch.primerIndex + 1;
    features.push({
      name: `${label} mismatch`,
      type: "mutation",
      start: position,
      end: position,
      strand,
      note: `${mismatch.templateBase}→${mismatch.primerBase} in the primer 5′→3′ orientation`,
    });
  }
  return features.filter(({ start, end }) => start >= 1 && end <= productLength);
}

function bindingOptions(bindingLength: number | undefined, options: PcrSimulationOptions): PrimerBindingOptions {
  return {
    bindingLength,
    minimumThreePrimeMatch: options.minimumThreePrimeMatch,
    maximumMismatches: options.maximumMismatches,
  };
}

function buildPcrProduct(
  template: string,
  forwardPrimerValue: string,
  reversePrimerValue: string,
  forward: PrimerBinding,
  reverse: PrimerBinding,
  mode: "standard" | "inverse",
  circular: boolean,
) {
  const forwardPrimer = analyzePrimer(forwardPrimerValue).sequence;
  const reversePrimer = analyzePrimer(reversePrimerValue).sequence;
  const forwardStart = forward.start - 1;
  const forwardEndExclusive = forwardStart + forward.bindingLength;
  let reverseStart = reverse.start - 1;
  if (circular && reverseStart < forwardEndExclusive) reverseStart += template.length;
  if (reverseStart < forwardEndExclusive) return null;
  const internalLength = reverseStart - forwardEndExclusive;
  if (circular && internalLength > template.length - forward.bindingLength) return null;
  const internal = circular
    ? circularSlice(template, forwardEndExclusive % template.length, internalLength)
    : template.slice(forwardEndExclusive, reverseStart);
  const sequence = forwardPrimer + internal + reverseComplement(reversePrimer);
  const reverseProductEnd = sequence.length;
  const features = [
    ...primerFeatures(forwardPrimer, forward, 1, sequence.length, "+", "Forward"),
    ...primerFeatures(reversePrimer, reverse, reverseProductEnd, sequence.length, "-", "Reverse"),
  ];
  const warnings = [
    ...bindingWarnings(forward, "Forward primer"),
    ...bindingWarnings(reverse, "Reverse primer"),
  ];
  const pairComplementarity = longestComplementaryRun(forwardPrimer, reversePrimer);
  if (pairComplementarity >= 5) warnings.push(`The primer pair has a ${pairComplementarity}-base complementary run; inspect it for primer-dimer formation.`);
  return {
    mode,
    sequence,
    start: forward.start,
    end: reverse.end,
    length: sequence.length,
    gcPercent: gcPercent(sequence),
    wrapsOrigin: circular && reverse.start - 1 < forwardEndExclusive,
    forwardBinding: forward,
    reverseBinding: reverse,
    features,
    warnings: [...new Set(warnings)],
  } satisfies PcrProduct;
}

export function simulatePcr(
  templateValue: string,
  forwardPrimer: string,
  reversePrimer: string,
  circular = false,
  options: PcrSimulationOptions = {},
): PcrProduct | null {
  const template = normalizeDnaSequence(templateValue);
  if (!template) return null;
  const forwardBindings = findPrimerBindings(template, forwardPrimer, circular, bindingOptions(options.forwardBindingLength, options))
    .filter(({ strand }) => strand === "+");
  const reverseBindings = findPrimerBindings(template, reversePrimer, circular, bindingOptions(options.reverseBindingLength, options))
    .filter(({ strand }) => strand === "-");
  const products: PcrProduct[] = [];
  for (const forward of forwardBindings) {
    for (const reverse of reverseBindings) {
      const product = buildPcrProduct(template, forwardPrimer, reversePrimer, forward, reverse, "standard", circular);
      if (product) products.push(product);
    }
  }
  return products.sort((a, b) => a.length - b.length || a.start - b.start)[0] ?? null;
}

export function simulateInversePcr(
  templateValue: string,
  forwardPrimer: string,
  reversePrimer: string,
  options: PcrSimulationOptions = {},
): PcrProduct | null {
  const template = normalizeDnaSequence(templateValue);
  if (!template) return null;
  const forwardBindings = findPrimerBindings(template, forwardPrimer, true, bindingOptions(options.forwardBindingLength, options))
    .filter(({ strand }) => strand === "+");
  const reverseBindings = findPrimerBindings(template, reversePrimer, true, bindingOptions(options.reverseBindingLength, options))
    .filter(({ strand }) => strand === "-");
  const products: PcrProduct[] = [];
  for (const forward of forwardBindings) {
    for (const reverse of reverseBindings) {
      // In displayed coordinates, an outward-facing pair has the reverse primer to the left.
      if (reverse.start >= forward.start) continue;
      const product = buildPcrProduct(template, forwardPrimer, reversePrimer, forward, reverse, "inverse", true);
      if (product?.wrapsOrigin) {
        product.warnings.push("Inverse-PCR output is a linear amplicon; circularization or assembly is still required to make a plasmid.");
        products.push(product);
      }
    }
  }
  return products.sort((a, b) => a.length - b.length || a.start - b.start)[0] ?? null;
}

function longestSuffixPrefix(left: string, right: string, minimum: number) {
  const maximum = Math.min(left.length, right.length);
  for (let length = maximum; length >= minimum; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

function consolidateProductFeatures(features: PcrProductFeature[]) {
  const consolidated: PcrProductFeature[] = [];
  const exactKeys = new Set<string>();
  for (const feature of features) {
    const exactKey = `${feature.type}:${feature.start}:${feature.end}:${feature.name}`;
    if (exactKeys.has(exactKey)) continue;
    if (feature.type === "mutation") {
      const existing = consolidated.find((candidate) => candidate.type === "mutation"
        && candidate.start === feature.start && candidate.end === feature.end);
      if (existing) {
        existing.name = "Overlap mutation";
        existing.strand = "both";
        existing.note = "Encoded by both complementary internal primers.";
        continue;
      }
    }
    consolidated.push({ ...feature });
    exactKeys.add(exactKey);
  }
  return consolidated;
}

export function simulateOverlapExtensionPcr(
  templateValue: string,
  outerForwardPrimer: string,
  internalReversePrimer: string,
  internalForwardPrimer: string,
  outerReversePrimer: string,
  circular = false,
  options: OverlapExtensionOptions = {},
): PcrProduct | null {
  const left = simulatePcr(templateValue, outerForwardPrimer, internalReversePrimer, circular, {
    ...options,
    reverseBindingLength: options.internalReverseBindingLength,
  });
  const right = simulatePcr(templateValue, internalForwardPrimer, outerReversePrimer, circular, {
    ...options,
    forwardBindingLength: options.internalForwardBindingLength,
  });
  if (!left || !right) return null;
  const minimumOverlap = Math.max(8, Math.floor(options.minimumOverlap ?? 15));
  const overlapLength = longestSuffixPrefix(left.sequence, right.sequence, minimumOverlap);
  if (!overlapLength || overlapLength >= left.sequence.length || overlapLength >= right.sequence.length) return null;
  const sequence = left.sequence + right.sequence.slice(overlapLength);
  const rightOffset = left.sequence.length - overlapLength;
  const features = consolidateProductFeatures([
    ...left.features,
    ...right.features.map((feature) => ({ ...feature, start: feature.start + rightOffset, end: feature.end + rightOffset })),
    {
      name: "Overlap-extension junction",
      type: "overlap",
      start: left.sequence.length - overlapLength + 1,
      end: left.sequence.length,
      strand: "both",
      note: `${overlapLength} bp exact overlap between the two primary amplicons`,
    },
  ]);
  const overlapTm = analyzePrimer(left.sequence.slice(-overlapLength)).meltingTemperature;
  const warnings = [...left.warnings, ...right.warnings];
  if (overlapLength < 20) warnings.push(`The overlap is ${overlapLength} bp; extend the mutagenic overlap to 20 bp or more if assembly is inefficient.`);
  if (overlapTm < 50) warnings.push(`The overlap Tm is ${overlapTm.toFixed(1)}°C; lengthen or rebalance the overlap.`);
  return {
    mode: "overlap-extension",
    sequence,
    start: left.start,
    end: right.end,
    length: sequence.length,
    gcPercent: gcPercent(sequence),
    wrapsOrigin: left.wrapsOrigin || right.wrapsOrigin,
    forwardBinding: left.forwardBinding,
    reverseBinding: right.reverseBinding,
    features,
    warnings: [...new Set(warnings)],
    overlapLength,
    fragments: [left, right],
  };
}

function candidateWarnings(analysis: PrimerAnalysis, bindingCount: number) {
  const warnings: string[] = [];
  if (bindingCount !== 1) warnings.push(bindingCount ? `Choose a more unique 3′ region; this primer has ${bindingCount} template bindings.` : "Move or lengthen the primer because it has no validated template binding.");
  if (analysis.gcPercent < 35) warnings.push("Lengthen the binding region or move it toward higher GC; GC is below 35%.");
  if (analysis.gcPercent > 65) warnings.push("Shorten the binding region or move it toward lower GC; GC is above 65%.");
  if (analysis.meltingTemperature < 55) warnings.push("Lengthen the 3′ binding region; annealing Tm is below 55°C.");
  if (analysis.meltingTemperature > 68) warnings.push("Shorten the 3′ binding region; annealing Tm is above 68°C.");
  if (/(A{5}|C{5}|G{5}|T{5})/.test(analysis.bindingSequence)) warnings.push("Move the primer to remove its homopolymer run of 5 or more bases.");
  if (!/[GC]$/.test(analysis.bindingSequence)) warnings.push("Consider shifting the primer to add a G/C clamp at the 3′ end.");
  if ((analysis.bindingSequence.slice(-5).match(/[GC]/g)?.length ?? 0) > 3) warnings.push("The last 5 bases are GC-heavy; shift the 3′ end to reduce nonspecific priming.");
  if (analysis.hairpinScore >= 5) warnings.push(`Redesign to disrupt the predicted ${analysis.hairpinScore}-base hairpin stem.`);
  if (analysis.selfDimerScore >= 6) warnings.push(`Redesign to disrupt the predicted ${analysis.selfDimerScore}-base self-dimer run.`);
  return warnings;
}

function scoreCandidate(analysis: PrimerAnalysis, bindingCount: number, desiredTm: number) {
  const gcPenalty = analysis.gcPercent < 40
    ? 40 - analysis.gcPercent
    : analysis.gcPercent > 60 ? analysis.gcPercent - 60 : 0;
  const uniquenessPenalty = bindingCount === 1 ? 0 : bindingCount === 0 ? 90 : 35 + bindingCount * 3;
  const homopolymerPenalty = /(A{5}|C{5}|G{5}|T{5})/.test(analysis.bindingSequence) ? 22 : 0;
  const weakTerminalPenalty = /[GC]$/.test(analysis.bindingSequence) ? 0 : 2;
  const strongTerminalPenalty = (analysis.bindingSequence.slice(-5).match(/[GC]/g)?.length ?? 0) > 3 ? 4 : 0;
  const structurePenalty = Math.max(0, analysis.hairpinScore - 3) * 4 + Math.max(0, analysis.selfDimerScore - 4) * 3;
  return Math.abs(analysis.meltingTemperature - desiredTm) * 2 + gcPenalty + uniquenessPenalty
    + homopolymerPenalty + weakTerminalPenalty + strongTerminalPenalty + structurePenalty;
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
    const bindingCount = findPrimerBindings(template, sequence, circular, { bindingLength: length }).length;
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
  let best: { forward: PrimerDesignCandidate; reverse: PrimerDesignCandidate; score: number; pairComplementarity: number } | null = null;
  for (const forward of forwardPool) {
    for (const reverse of reversePool) {
      const tmDifference = Math.abs(forward.meltingTemperature - reverse.meltingTemperature);
      const geometryPenalty = purpose === "pcr" && forward.start >= reverse.end ? 1_000 : 0;
      const pairComplementarity = longestComplementaryRun(forward.sequence, reverse.sequence);
      const score = forward.score + reverse.score + tmDifference * 3 + geometryPenalty + Math.max(0, pairComplementarity - 3) * 5;
      if (!best || score < best.score) best = { forward, reverse, score, pairComplementarity };
    }
  }
  if (!best) throw new Error("No primer pair could be designed for that interval.");

  const product = purpose === "pcr"
    ? simulatePcr(template, best.forward.sequence, best.reverse.sequence, circular, {
      forwardBindingLength: best.forward.bindingLength,
      reverseBindingLength: best.reverse.bindingLength,
    })
    : null;
  const meltingTemperatureDifference = Math.abs(best.forward.meltingTemperature - best.reverse.meltingTemperature);
  const warnings: string[] = [];
  if (meltingTemperatureDifference > 3) warnings.push(`Primer Tm values differ by ${meltingTemperatureDifference.toFixed(1)}°C; adjust one binding length to bring them within 3°C.`);
  if (best.pairComplementarity >= 5) warnings.push(`The pair contains a ${best.pairComplementarity}-base complementary run; shift a primer to reduce primer-dimer risk.`);
  return {
    purpose,
    targetStart,
    targetEnd,
    forward: best.forward,
    reverse: best.reverse,
    meltingTemperatureDifference,
    predictedAmpliconLength: product?.length ?? null,
    warnings,
  };
}

export function translateReadingFrame(sequenceValue: string, frame: 1 | 2 | 3 | -1 | -2 | -3) {
  const sequence = normalizeDnaSequence(sequenceValue);
  const strand = frame > 0 ? sequence : reverseComplement(sequence);
  return translate(strand.slice(Math.abs(frame) - 1));
}
