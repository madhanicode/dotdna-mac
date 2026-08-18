export type RestrictionSite = {
  enzyme: string;
  position: number;
  recognitionSequence: string;
};

const enzymes = [
  ["BamHI", "GGATCC"],
  ["BsaI", "GGTCTC"],
  ["EcoRI", "GAATTC"],
  ["HindIII", "AAGCTT"],
  ["NotI", "GCGGCCGC"],
  ["XhoI", "CTCGAG"],
] as const;

function reverseComplement(sequence: string) {
  const complement: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
  return [...sequence].reverse().map((base) => complement[base] ?? "N").join("");
}

export function findRestrictionSites(sequenceValue: string, circular: boolean): RestrictionSite[] {
  const sequence = sequenceValue.toUpperCase();
  if (!sequence) return [];
  const sites: RestrictionSite[] = [];
  for (const [enzyme, recognitionSequence] of enzymes) {
    const orientations = new Set([recognitionSequence, reverseComplement(recognitionSequence)]);
    const searchable = circular ? sequence + sequence.slice(0, recognitionSequence.length - 1) : sequence;
    for (const orientation of orientations) {
      let position = searchable.indexOf(orientation);
      while (position >= 0 && position < sequence.length) {
        sites.push({ enzyme, position, recognitionSequence });
        position = searchable.indexOf(orientation, position + 1);
      }
    }
  }
  return sites.sort((left, right) => left.position - right.position || left.enzyme.localeCompare(right.enzyme));
}
