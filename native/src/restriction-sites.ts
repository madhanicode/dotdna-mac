import { canonicalIntervals } from "./sequence-selection";
import type { SequenceSpan } from "./types";

export type RestrictionSite = {
  enzyme: string;
  position: number;
  recognitionSequence: string;
  matchedSequence: string;
  orientation: "forward" | "reverse";
  intervals: SequenceSpan[];
  wrapsOrigin: boolean;
  topCutPosition: number | null;
  bottomCutPosition: number | null;
};

export type RestrictionSiteScan = {
  sites: RestrictionSite[];
  truncated: boolean;
};

const enzymes = [
  { enzyme: "BamHI", recognitionSequence: "GGATCC", topCutOffset: 1, bottomCutOffset: 5 },
  { enzyme: "BsaI", recognitionSequence: "GGTCTC", topCutOffset: 7, bottomCutOffset: 11 },
  { enzyme: "EcoRI", recognitionSequence: "GAATTC", topCutOffset: 1, bottomCutOffset: 5 },
  { enzyme: "HindIII", recognitionSequence: "AAGCTT", topCutOffset: 1, bottomCutOffset: 5 },
  { enzyme: "NotI", recognitionSequence: "GCGGCCGC", topCutOffset: 2, bottomCutOffset: 6 },
  { enzyme: "XhoI", recognitionSequence: "CTCGAG", topCutOffset: 1, bottomCutOffset: 5 },
] as const;

function reverseComplement(sequence: string) {
  const complement: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
  return [...sequence].reverse().map((base) => complement[base] ?? "N").join("");
}

export function scanRestrictionSites(sequenceValue: string, circular: boolean, maximumSitesPerEnzyme = 1_000): RestrictionSiteScan {
  const sequence = sequenceValue.toUpperCase();
  if (!sequence) return { sites: [], truncated: false };
  const sites: RestrictionSite[] = [];
  let truncated = false;
  for (const definition of enzymes) {
    const { enzyme, recognitionSequence, topCutOffset, bottomCutOffset } = definition;
    const reverse = reverseComplement(recognitionSequence);
    const orientations = new Set([recognitionSequence, reverse]);
    const searchable = circular ? sequence + sequence.slice(0, recognitionSequence.length - 1) : sequence;
    let enzymeSiteCount = 0;
    orientationLoop: for (const orientation of orientations) {
      const strand = orientation === recognitionSequence ? "forward" : "reverse";
      let position = searchable.indexOf(orientation);
      while (position >= 0 && position < sequence.length) {
        if (enzymeSiteCount >= maximumSitesPerEnzyme) {
          truncated = true;
          break orientationLoop;
        }
        const rawTopCut = position + (strand === "forward" ? topCutOffset : recognitionSequence.length - bottomCutOffset);
        const rawBottomCut = position + (strand === "forward" ? bottomCutOffset : recognitionSequence.length - topCutOffset);
        const cutPosition = (value: number) => circular
          ? ((value % sequence.length) + sequence.length) % sequence.length
          : value >= 0 && value <= sequence.length ? value : null;
        const intervals = canonicalIntervals(position, recognitionSequence.length, sequence.length, circular);
        sites.push({
          enzyme,
          position,
          recognitionSequence,
          matchedSequence: orientation,
          orientation: strand,
          intervals,
          wrapsOrigin: intervals.length > 1,
          topCutPosition: cutPosition(rawTopCut),
          bottomCutPosition: cutPosition(rawBottomCut),
        });
        enzymeSiteCount += 1;
        position = searchable.indexOf(orientation, position + 1);
      }
    }
  }
  sites.sort((left, right) => left.position - right.position || left.enzyme.localeCompare(right.enzyme));
  return { sites, truncated };
}

export function findRestrictionSites(sequenceValue: string, circular: boolean): RestrictionSite[] {
  return scanRestrictionSites(sequenceValue, circular).sites;
}
