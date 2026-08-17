import {
  findRestrictionSites,
  RESTRICTION_ENZYMES,
  reverseComplement,
} from "./sequence-analysis.ts";
import type { RestrictionEnzyme, RestrictionSite } from "./sequence-analysis.ts";
import { normalizeDnaSequence } from "./snapgene.ts";
import type { SnapGeneFeature, SnapGeneSegment } from "./snapgene.ts";

export type AssemblyFragment = {
  name: string;
  sequence: string;
  features?: SnapGeneFeature[];
  circular?: boolean;
};

export type AssemblyWarning = {
  code: "auto-oriented" | "ambiguous-orientation" | "incompatible-ends" | "internal-site" | "site-orientation" | "reused-overhang" | "palindromic-overhang" | "blunt-golden-gate";
  severity: "warning" | "error";
  message: string;
  fragment?: string;
  junction?: number;
};

export type CloningEnd = {
  enzyme: string;
  recognition: string;
  polarity: "5′" | "3′" | "blunt";
  overhang: string;
  sourcePosition: number;
};

export type AssemblyJunction = {
  left: string;
  right: string;
  overlap: number;
  reverseComplemented: boolean;
  closure: boolean;
  leftEnd?: CloningEnd;
  rightEnd?: CloningEnd;
  compatible?: boolean;
};

export type AssemblyResult = {
  sequence: string;
  circular: boolean;
  method: "exact-overlap" | "restriction-cloning" | "golden-gate";
  fragments: Array<AssemblyFragment & {
    features: SnapGeneFeature[];
    reverseComplemented: boolean;
    leftEnd?: CloningEnd;
    rightEnd?: CloningEnd;
    sourceRange?: string;
  }>;
  junctions: AssemblyJunction[];
  features: SnapGeneFeature[];
  warnings: AssemblyWarning[];
  valid: boolean;
};

export type RestrictionFragmentSelection = AssemblyFragment & {
  leftEnzyme: string;
  rightEnzyme: string;
  retain?: "between" | "outside";
};

export type RestrictionFragmentResult = AssemblyFragment & {
  features: SnapGeneFeature[];
  reverseComplemented: boolean;
  leftEnd: CloningEnd;
  rightEnd: CloningEnd;
  sourceRange: string;
  warnings: AssemblyWarning[];
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

type MappingInterval = {
  sourceStart: number;
  sourceEnd: number;
  productStart: number;
};

function featureSegments(feature: SnapGeneFeature) {
  if (feature.segments.length) return feature.segments;
  const segments: SnapGeneSegment[] = [];
  for (const match of feature.range?.matchAll(/(\d+)\s*-\s*(\d+)/g) ?? []) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    segments.push({ range: `${start}-${end}`, start, end, color: feature.color, name: null, type: "standard" });
  }
  return segments;
}

function mapFeatures(features: SnapGeneFeature[] | undefined, intervals: MappingInterval[]) {
  return (features ?? []).flatMap((feature) => {
    const segments = featureSegments(feature).flatMap((segment) => {
      if (segment.start === null || segment.end === null) return [];
      const sourceStart = segment.start - 1;
      const sourceEnd = segment.end;
      return intervals.flatMap((interval) => {
        const overlapStart = Math.max(sourceStart, interval.sourceStart);
        const overlapEnd = Math.min(sourceEnd, interval.sourceEnd);
        if (overlapEnd <= overlapStart) return [];
        const start = interval.productStart + overlapStart - interval.sourceStart + 1;
        const end = interval.productStart + overlapEnd - interval.sourceStart;
        return [{ ...segment, start, end, range: `${start}-${end}` }];
      });
    }).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    if (!segments.length) return [];
    return [{
      ...feature,
      segments,
      range: segments.map(({ range }) => range).join(", "),
      color: segments.find(({ color }) => color)?.color ?? feature.color,
    }];
  });
}

function reverseFeatures(features: SnapGeneFeature[], length: number) {
  return features.map((feature) => {
    const segments = [...feature.segments].reverse().map((segment) => {
      if (segment.start === null || segment.end === null) return segment;
      const start = length - segment.end + 1;
      const end = length - segment.start + 1;
      return { ...segment, start, end, range: `${start}-${end}` };
    });
    return {
      ...feature,
      directionality: feature.directionality === 1 ? 2 as const : feature.directionality === 2 ? 1 as const : feature.directionality,
      strand: feature.strand === "+" ? "-" as const : feature.strand === "-" ? "+" as const : feature.strand,
      segments,
      range: segments.map(({ range }) => range).join(", ") || feature.range,
    };
  });
}

function wholeFragmentFeatures(fragment: AssemblyFragment) {
  return mapFeatures(fragment.features, [{ sourceStart: 0, sourceEnd: fragment.sequence.length, productStart: 0 }]);
}

function shiftFeatures(features: SnapGeneFeature[], offset: number) {
  if (!offset) return features;
  return features.map((feature) => {
    const segments = feature.segments.map((segment) => {
      if (segment.start === null || segment.end === null) return segment;
      const start = segment.start + offset;
      const end = segment.end + offset;
      return { ...segment, start, end, range: `${start}-${end}` };
    });
    return { ...feature, segments, range: segments.map(({ range }) => range).join(", ") || feature.range };
  });
}

function findEnzyme(name: string) {
  const enzyme = RESTRICTION_ENZYMES.find(({ name: candidate }) => candidate.toLowerCase() === name.trim().toLowerCase());
  if (!enzyme) throw new Error(`Unknown restriction enzyme “${name}”. Choose an enzyme from the DOTDNA catalog.`);
  return enzyme;
}

function rawCutPositions(site: RestrictionSite) {
  const recognitionStart = site.position - 1;
  if (site.strand === "+") {
    return {
      top: recognitionStart + site.enzyme.cutTop,
      bottom: recognitionStart + site.enzyme.cutBottom,
    };
  }
  return {
    top: recognitionStart + site.enzyme.recognition.length - site.enzyme.cutBottom,
    bottom: recognitionStart + site.enzyme.recognition.length - site.enzyme.cutTop,
  };
}

function siteEnd(sequence: string, site: RestrictionSite): CloningEnd {
  const cuts = rawCutPositions(site);
  const overhangStart = Math.min(cuts.top, cuts.bottom);
  const overhangEnd = Math.max(cuts.top, cuts.bottom);
  if (overhangStart < 0 || overhangEnd > sequence.length) {
    throw new Error(`${site.enzyme.name} at ${site.position} in the selected fragment does not have enough flanking sequence to make its full cut. Add flanking bases or choose another site.`);
  }
  return {
    enzyme: site.enzyme.name,
    recognition: site.enzyme.recognition,
    polarity: cuts.top === cuts.bottom ? "blunt" : cuts.top < cuts.bottom ? "5′" : "3′",
    overhang: sequence.slice(overhangStart, overhangEnd),
    sourcePosition: cuts.top + 1,
  };
}

function describeEnd(end: CloningEnd) {
  return end.polarity === "blunt" ? `${end.enzyme} blunt end` : `${end.enzyme} ${end.polarity}–${end.overhang}`;
}

export function restrictionEndsCompatible(left: CloningEnd, right: CloningEnd) {
  if (left.polarity === "blunt" || right.polarity === "blunt") {
    return left.polarity === "blunt" && right.polarity === "blunt";
  }
  return left.polarity === right.polarity && left.overhang === right.overhang;
}

function reverseEnd(end: CloningEnd): CloningEnd {
  return { ...end, overhang: reverseComplement(end.overhang) };
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
    features: wholeFragmentFeatures({ ...fragment, sequence: cleanDna(fragment.sequence) }),
  }));
  if (normalized.some(({ sequence }) => !sequence)) throw new Error("Every fragment needs a DNA sequence.");

  const oriented: AssemblyResult["fragments"] = [{ ...normalized[0], reverseComplemented: false }];
  const junctions: AssemblyJunction[] = [];
  const warnings: AssemblyWarning[] = [];
  let product = normalized[0].sequence;
  let productFeatures = normalized[0].features;

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
    const features = useReverse ? reverseFeatures(fragment.features, sequence.length) : fragment.features;
    const appendedFeatures = mapFeatures(features, [{ sourceStart: overlap, sourceEnd: sequence.length, productStart: product.length }]);
    productFeatures.push(...appendedFeatures);
    product += sequence.slice(overlap);
    junctions.push({
      left: oriented.at(-1)?.name ?? `Fragment ${index}`,
      right: fragment.name,
      overlap,
      reverseComplemented: useReverse,
      closure: false,
    });
    if (useReverse) {
      warnings.push({
        code: "auto-oriented",
        severity: "warning",
        fragment: fragment.name,
        junction: index,
        message: `${fragment.name} was reverse-complemented to satisfy its exact overlap. Confirm that this is the intended feature orientation.`,
      });
    }
    oriented.push({ name: fragment.name, sequence, features, reverseComplemented: useReverse });
  }

  if (options.circular) {
    const first = oriented[0];
    const maximumClosure = Math.min(product.length - 1, first.sequence.length);
    const overlap = longestSuffixPrefix(product, first.sequence, minimumOverlap, maximumClosure);
    if (!overlap) throw new Error(`The final product does not close onto ${first.name} with an exact overlap of ${minimumOverlap} bp or longer.`);
    product = product.slice(0, -overlap);
    productFeatures = mapFeatures(productFeatures, [{ sourceStart: 0, sourceEnd: product.length, productStart: 0 }]);
    junctions.push({
      left: oriented.at(-1)?.name ?? "Final fragment",
      right: first.name,
      overlap,
      reverseComplemented: false,
      closure: true,
    });
  }

  return {
    sequence: product,
    circular: Boolean(options.circular),
    method: "exact-overlap",
    fragments: oriented,
    junctions,
    features: productFeatures,
    warnings,
    valid: true,
  };
}

function chooseRestrictionSites(
  sequence: string,
  leftEnzyme: RestrictionEnzyme,
  rightEnzyme: RestrictionEnzyme,
  requireInwardFacing: boolean,
) {
  const enzymes = leftEnzyme.name === rightEnzyme.name ? [leftEnzyme] : [leftEnzyme, rightEnzyme];
  const sites = findRestrictionSites(sequence, enzymes, false);
  const leftSites = sites.filter(({ enzyme }) => enzyme.name === leftEnzyme.name);
  const rightSites = sites.filter(({ enzyme }) => enzyme.name === rightEnzyme.name);
  if (!leftSites.length) throw new Error(`${leftEnzyme.name} does not cut this fragment. Add a ${leftEnzyme.recognition} site or choose another left enzyme.`);
  if (!rightSites.length) throw new Error(`${rightEnzyme.name} does not cut this fragment. Add a ${rightEnzyme.recognition} site or choose another right enzyme.`);

  const pairs = (leftPool: RestrictionSite[], rightPool: RestrictionSite[]) => leftPool.flatMap((left) => rightPool.flatMap((right) => {
    if (left.id === right.id) return [];
    const leftCuts = rawCutPositions(left);
    const rightCuts = rawCutPositions(right);
    if (Math.min(leftCuts.top, leftCuts.bottom, rightCuts.top, rightCuts.bottom) < 0) return [];
    if (Math.max(leftCuts.top, leftCuts.bottom, rightCuts.top, rightCuts.bottom) > sequence.length) return [];
    return leftCuts.top < rightCuts.top ? [{ left, right, leftCuts, rightCuts }] : [];
  })).sort((a, b) => (b.rightCuts.top - b.leftCuts.top) - (a.rightCuts.top - a.leftCuts.top));

  const inwardPairs = requireInwardFacing
    ? pairs(leftSites.filter(({ strand }) => strand === "+"), rightSites.filter(({ strand }) => strand === "-"))
    : [];
  const pair = inwardPairs[0] ?? pairs(leftSites, rightSites)[0];
  if (!pair) {
    throw new Error(`${leftEnzyme.name} must cut before ${rightEnzyme.name} with enough flanking sequence. Swap the enzyme choices, reverse-complement the source, or move the sites.`);
  }
  return { ...pair, sites, inwardFacing: pair.left.strand === "+" && pair.right.strand === "-" };
}

export function selectRestrictionFragment(
  fragment: RestrictionFragmentSelection,
  options: { requireInwardFacing?: boolean } = {},
): RestrictionFragmentResult {
  const name = fragment.name.trim() || "Fragment";
  const sequence = cleanDna(fragment.sequence);
  if (!sequence) throw new Error(`${name} needs a DNA sequence.`);
  const leftEnzyme = findEnzyme(fragment.leftEnzyme);
  const rightEnzyme = findEnzyme(fragment.rightEnzyme);
  const retain = fragment.retain ?? "between";
  if (retain === "outside" && !fragment.circular) {
    throw new Error(`${name} can retain the sequence outside its two sites only when the source is circular. Mark it as a circular vector or retain the interval between the sites.`);
  }

  const chosen = chooseRestrictionSites(sequence, leftEnzyme, rightEnzyme, Boolean(options.requireInwardFacing));
  const warnings: AssemblyWarning[] = [];
  if (options.requireInwardFacing && !chosen.inwardFacing) {
    warnings.push({
      code: "site-orientation",
      severity: "error",
      fragment: name,
      message: `${name} does not have an inward-facing ${leftEnzyme.name} site on the left and reverse ${rightEnzyme.name} site on the right. Reorient one recognition site so digestion releases the intended part.`,
    });
  }

  const chosenIds = new Set([chosen.left.id, chosen.right.id]);
  const internalSites = chosen.sites.filter((site) => {
    if (chosenIds.has(site.id)) return false;
    const cut = rawCutPositions(site).top;
    return retain === "between"
      ? cut > chosen.leftCuts.top && cut < chosen.rightCuts.top
      : cut < chosen.leftCuts.top || cut > chosen.rightCuts.top;
  });
  if (internalSites.length) {
    const siteSummary = [...new Set(internalSites.map(({ enzyme }) => enzyme.name))].join("/");
    warnings.push({
      code: "internal-site",
      severity: "error",
      fragment: name,
      message: `${name} contains ${internalSites.length} additional ${siteSummary} cut site${internalSites.length === 1 ? "" : "s"} in the retained fragment. Remove or domesticate ${internalSites.length === 1 ? "that site" : "those sites"} before assembly.`,
    });
  }

  let intervals: MappingInterval[];
  let selectedSequence: string;
  let leftEnd: CloningEnd;
  let rightEnd: CloningEnd;
  let sourceRange: string;
  if (retain === "between") {
    intervals = [{ sourceStart: chosen.leftCuts.top, sourceEnd: chosen.rightCuts.top, productStart: 0 }];
    selectedSequence = sequence.slice(chosen.leftCuts.top, chosen.rightCuts.top);
    leftEnd = siteEnd(sequence, chosen.left);
    rightEnd = siteEnd(sequence, chosen.right);
    sourceRange = `${chosen.leftCuts.top + 1}-${chosen.rightCuts.top}`;
  } else {
    const tailLength = sequence.length - chosen.rightCuts.top;
    intervals = [
      { sourceStart: chosen.rightCuts.top, sourceEnd: sequence.length, productStart: 0 },
      { sourceStart: 0, sourceEnd: chosen.leftCuts.top, productStart: tailLength },
    ].filter(({ sourceStart, sourceEnd }) => sourceEnd > sourceStart);
    selectedSequence = sequence.slice(chosen.rightCuts.top) + sequence.slice(0, chosen.leftCuts.top);
    leftEnd = siteEnd(sequence, chosen.right);
    rightEnd = siteEnd(sequence, chosen.left);
    sourceRange = `${chosen.rightCuts.top + 1}-${sequence.length}, 1-${chosen.leftCuts.top}`;
  }
  if (!selectedSequence) throw new Error(`${name}'s selected restriction fragment is empty. Choose sites that enclose retained bases.`);

  return {
    name,
    sequence: selectedSequence,
    circular: false,
    features: mapFeatures(fragment.features, intervals),
    reverseComplemented: false,
    leftEnd,
    rightEnd,
    sourceRange,
    warnings,
  };
}

function reverseRestrictionFragment(fragment: RestrictionFragmentResult): RestrictionFragmentResult {
  const leftIncluded = fragment.leftEnd.polarity === "5′" ? fragment.leftEnd.overhang.length : 0;
  const rightIncluded = fragment.rightEnd.polarity === "3′" ? fragment.rightEnd.overhang.length : 0;
  const coreEnd = fragment.sequence.length - rightIncluded;
  const core = fragment.sequence.slice(leftIncluded, coreEnd);
  const nextLeftIncluded = fragment.rightEnd.polarity === "5′" ? fragment.rightEnd.overhang.length : 0;
  const coreFeatures = mapFeatures(fragment.features, [{ sourceStart: leftIncluded, sourceEnd: coreEnd, productStart: 0 }]);
  const sequence = `${fragment.rightEnd.polarity === "5′" ? reverseComplement(fragment.rightEnd.overhang) : ""}${reverseComplement(core)}${fragment.leftEnd.polarity === "3′" ? reverseComplement(fragment.leftEnd.overhang) : ""}`;
  return {
    ...fragment,
    sequence,
    features: shiftFeatures(reverseFeatures(coreFeatures, core.length), nextLeftIncluded),
    reverseComplemented: !fragment.reverseComplemented,
    leftEnd: reverseEnd(fragment.rightEnd),
    rightEnd: reverseEnd(fragment.leftEnd),
  };
}

function compatibleJunctionCount(fragments: RestrictionFragmentResult[], circular: boolean) {
  let count = 0;
  for (let index = 0; index < fragments.length - 1; index += 1) {
    if (restrictionEndsCompatible(fragments[index].rightEnd, fragments[index + 1].leftEnd)) count += 1;
  }
  if (circular && restrictionEndsCompatible(fragments.at(-1)!.rightEnd, fragments[0].leftEnd)) count += 1;
  return count;
}

function planDigestedAssembly(
  selected: RestrictionFragmentResult[],
  method: "restriction-cloning" | "golden-gate",
  circular: boolean,
): AssemblyResult {
  if (selected.length < 2) throw new Error("Cloning requires at least two selected fragments.");
  if (selected.length > 12) throw new Error("This preview accepts up to 12 fragments at a time.");
  const candidates: Array<{ fragments: RestrictionFragmentResult[]; score: number; reversals: number }> = [];
  const orientationCount = 2 ** (selected.length - 1);
  for (let mask = 0; mask < orientationCount; mask += 1) {
    const fragments = selected.map((fragment, index) => index > 0 && (mask & (1 << (index - 1)))
      ? reverseRestrictionFragment(fragment)
      : fragment);
    candidates.push({
      fragments,
      score: compatibleJunctionCount(fragments, circular),
      reversals: fragments.filter(({ reverseComplemented }) => reverseComplemented).length,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.reversals - b.reversals);
  const best = candidates[0];
  const expectedJunctions = selected.length - 1 + (circular ? 1 : 0);
  const warnings = selected.flatMap(({ warnings }) => warnings);
  for (const fragment of best.fragments) {
    if (fragment.reverseComplemented) {
      warnings.push({
        code: "auto-oriented",
        severity: "warning",
        fragment: fragment.name,
        message: `${fragment.name} was reverse-complemented to maximize compatible junctions. Confirm that its propagated features now have the intended orientation.`,
      });
    }
  }
  const equallyValid = candidates.filter(({ score }) => score === expectedJunctions);
  if (equallyValid.length > 1) {
    warnings.push({
      code: "ambiguous-orientation",
      severity: "warning",
      message: `${equallyValid.length} fragment-orientation combinations have compatible ends. Use two different non-palindromic end sequences around directional inserts to enforce one orientation.`,
    });
  }

  const junctions: AssemblyJunction[] = [];
  const addJunction = (left: RestrictionFragmentResult, right: RestrictionFragmentResult, closure: boolean, index: number) => {
    const compatible = restrictionEndsCompatible(left.rightEnd, right.leftEnd);
    junctions.push({
      left: left.name,
      right: right.name,
      overlap: 0,
      reverseComplemented: right.reverseComplemented,
      closure,
      leftEnd: left.rightEnd,
      rightEnd: right.leftEnd,
      compatible,
    });
    if (!compatible) {
      warnings.push({
        code: "incompatible-ends",
        severity: "error",
        junction: index + 1,
        message: `${left.name} ends with ${describeEnd(left.rightEnd)}, but ${right.name} starts with ${describeEnd(right.leftEnd)}. Choose enzymes that make the same overhang and polarity, or reverse the intended fragment.`,
      });
    }
  };
  for (let index = 0; index < best.fragments.length - 1; index += 1) {
    addJunction(best.fragments[index], best.fragments[index + 1], false, index);
  }
  if (circular) addJunction(best.fragments.at(-1)!, best.fragments[0], true, best.fragments.length - 1);

  let offset = 0;
  const features: SnapGeneFeature[] = [];
  for (const fragment of best.fragments) {
    features.push(...shiftFeatures(fragment.features, offset));
    offset += fragment.sequence.length;
  }
  return {
    sequence: best.fragments.map(({ sequence }) => sequence).join(""),
    circular,
    method,
    fragments: best.fragments,
    junctions,
    features,
    warnings,
    valid: warnings.every(({ severity }) => severity !== "error"),
  };
}

export function planRestrictionCloning(
  fragments: RestrictionFragmentSelection[],
  options: { circular?: boolean } = {},
): AssemblyResult {
  const selected = fragments.map((fragment) => selectRestrictionFragment(fragment));
  return planDigestedAssembly(selected, "restriction-cloning", options.circular ?? true);
}

export function planGoldenGateAssembly(
  fragments: AssemblyFragment[],
  options: { enzyme?: string; enzymeName?: string; circular?: boolean } = {},
): AssemblyResult {
  const enzyme = findEnzyme(options.enzymeName ?? options.enzyme ?? "BsaI");
  if (enzyme.kind !== "Type IIS") {
    throw new Error(`${enzyme.name} is a Type II enzyme. Choose a Type IIS enzyme such as BsaI, BsmBI, BbsI, SapI, AarI, or BfuAI for Golden Gate planning.`);
  }
  const selected = fragments.map((fragment) => selectRestrictionFragment({
    ...fragment,
    circular: false,
    leftEnzyme: enzyme.name,
    rightEnzyme: enzyme.name,
    retain: "between",
  }, { requireInwardFacing: true }));
  const result = planDigestedAssembly(selected, "golden-gate", options.circular ?? true);
  const junctionOverhangs = result.junctions
    .filter(({ compatible }) => compatible)
    .map(({ leftEnd }) => leftEnd?.overhang ?? "");

  if (result.junctions.some(({ leftEnd }) => leftEnd?.polarity === "blunt")) {
    result.warnings.push({
      code: "blunt-golden-gate",
      severity: "error",
      message: `${enzyme.name} produced a blunt junction. Choose a Type IIS enzyme/cut design that exposes distinct cohesive overhangs.`,
    });
  }
  const reused = [...new Set(junctionOverhangs.filter((overhang, index) => overhang && junctionOverhangs.indexOf(overhang) !== index))];
  if (reused.length) {
    result.warnings.push({
      code: "reused-overhang",
      severity: "warning",
      message: `Golden Gate overhang${reused.length === 1 ? "" : "s"} ${reused.join(", ")} ${reused.length === 1 ? "is" : "are"} reused at multiple junctions. Assign a unique overhang to each junction to reduce misassembly.`,
    });
  }
  const palindromic = [...new Set(junctionOverhangs.filter((overhang) => overhang && overhang === reverseComplement(overhang)))];
  if (palindromic.length) {
    result.warnings.push({
      code: "palindromic-overhang",
      severity: "warning",
      message: `Golden Gate overhang${palindromic.length === 1 ? "" : "s"} ${palindromic.join(", ")} ${palindromic.length === 1 ? "is" : "are"} palindromic and can ligate in either orientation. Replace with directional overhangs.`,
    });
  }
  result.valid = result.warnings.every(({ severity }) => severity !== "error");
  return result;
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
