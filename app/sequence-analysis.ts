export type OrfStartMode = "atg" | "common";

export type OpenReadingFrame = {
  id: string;
  start: number;
  end: number;
  strand: "+" | "-";
  frame: 1 | 2 | 3 | -1 | -2 | -3;
  aminoAcidLength: number;
  nucleotideLength: number;
  protein: string;
  wrapsOrigin: boolean;
};

export type RestrictionEnzyme = {
  name: string;
  recognition: string;
  kind: "Type II" | "Type IIS";
};

export type RestrictionSite = {
  id: string;
  enzyme: RestrictionEnzyme;
  position: number;
  end: number;
  strand: "+" | "-";
  wrapsOrigin: boolean;
};

const complements: Record<string, string> = {
  A: "T", T: "A", U: "A", C: "G", G: "C",
  R: "Y", Y: "R", S: "S", W: "W", K: "M", M: "K",
  B: "V", V: "B", D: "H", H: "D", N: "N",
};

const iupacPattern: Record<string, string> = {
  A: "A", C: "C", G: "G", T: "T", U: "T",
  R: "[AG]", Y: "[CT]", S: "[GC]", W: "[AT]", K: "[GT]", M: "[AC]",
  B: "[CGT]", D: "[AGT]", H: "[ACT]", V: "[ACG]", N: "[ACGT]",
};

const codonTable: Record<string, string> = {
  TTT: "F", TTC: "F", TTA: "L", TTG: "L", TCT: "S", TCC: "S", TCA: "S", TCG: "S",
  TAT: "Y", TAC: "Y", TAA: "*", TAG: "*", TGT: "C", TGC: "C", TGA: "*", TGG: "W",
  CTT: "L", CTC: "L", CTA: "L", CTG: "L", CCT: "P", CCC: "P", CCA: "P", CCG: "P",
  CAT: "H", CAC: "H", CAA: "Q", CAG: "Q", CGT: "R", CGC: "R", CGA: "R", CGG: "R",
  ATT: "I", ATC: "I", ATA: "I", ATG: "M", ACT: "T", ACC: "T", ACA: "T", ACG: "T",
  AAT: "N", AAC: "N", AAA: "K", AAG: "K", AGT: "S", AGC: "S", AGA: "R", AGG: "R",
  GTT: "V", GTC: "V", GTA: "V", GTG: "V", GCT: "A", GCC: "A", GCA: "A", GCG: "A",
  GAT: "D", GAC: "D", GAA: "E", GAG: "E", GGT: "G", GGC: "G", GGA: "G", GGG: "G",
};

const stopCodons = new Set(["TAA", "TAG", "TGA"]);

export const RESTRICTION_ENZYMES: RestrictionEnzyme[] = [
  { name: "AarI", recognition: "CACCTGC", kind: "Type IIS" },
  { name: "AflII", recognition: "CTTAAG", kind: "Type II" },
  { name: "AgeI", recognition: "ACCGGT", kind: "Type II" },
  { name: "ApaI", recognition: "GGGCCC", kind: "Type II" },
  { name: "AscI", recognition: "GGCGCGCC", kind: "Type II" },
  { name: "AvrII", recognition: "CCTAGG", kind: "Type II" },
  { name: "BamHI", recognition: "GGATCC", kind: "Type II" },
  { name: "BbsI", recognition: "GAAGAC", kind: "Type IIS" },
  { name: "BfuAI", recognition: "ACCTGC", kind: "Type IIS" },
  { name: "BglII", recognition: "AGATCT", kind: "Type II" },
  { name: "BsaI", recognition: "GGTCTC", kind: "Type IIS" },
  { name: "BsiWI", recognition: "CGTACG", kind: "Type II" },
  { name: "BsmBI", recognition: "CGTCTC", kind: "Type IIS" },
  { name: "ClaI", recognition: "ATCGAT", kind: "Type II" },
  { name: "DraI", recognition: "TTTAAA", kind: "Type II" },
  { name: "EcoRI", recognition: "GAATTC", kind: "Type II" },
  { name: "EcoRV", recognition: "GATATC", kind: "Type II" },
  { name: "FspI", recognition: "TGCGCA", kind: "Type II" },
  { name: "HaeIII", recognition: "GGCC", kind: "Type II" },
  { name: "HindIII", recognition: "AAGCTT", kind: "Type II" },
  { name: "HpaI", recognition: "GTTAAC", kind: "Type II" },
  { name: "KpnI", recognition: "GGTACC", kind: "Type II" },
  { name: "MfeI", recognition: "CAATTG", kind: "Type II" },
  { name: "MluI", recognition: "ACGCGT", kind: "Type II" },
  { name: "NcoI", recognition: "CCATGG", kind: "Type II" },
  { name: "NdeI", recognition: "CATATG", kind: "Type II" },
  { name: "NheI", recognition: "GCTAGC", kind: "Type II" },
  { name: "NotI", recognition: "GCGGCCGC", kind: "Type II" },
  { name: "PacI", recognition: "TTAATTAA", kind: "Type II" },
  { name: "PstI", recognition: "CTGCAG", kind: "Type II" },
  { name: "PvuII", recognition: "CAGCTG", kind: "Type II" },
  { name: "SacI", recognition: "GAGCTC", kind: "Type II" },
  { name: "SalI", recognition: "GTCGAC", kind: "Type II" },
  { name: "SapI", recognition: "GCTCTTC", kind: "Type IIS" },
  { name: "SbfI", recognition: "CCTGCAGG", kind: "Type II" },
  { name: "SmaI", recognition: "CCCGGG", kind: "Type II" },
  { name: "SpeI", recognition: "ACTAGT", kind: "Type II" },
  { name: "SphI", recognition: "GCATGC", kind: "Type II" },
  { name: "SwaI", recognition: "ATTTAAAT", kind: "Type II" },
  { name: "XbaI", recognition: "TCTAGA", kind: "Type II" },
  { name: "XhoI", recognition: "CTCGAG", kind: "Type II" },
];

export function reverseComplement(sequence: string) {
  return sequence
    .toUpperCase()
    .split("")
    .reverse()
    .map((base) => complements[base] ?? "N")
    .join("");
}

export function translate(sequence: string) {
  let protein = "";
  for (let index = 0; index + 3 <= sequence.length; index += 3) {
    protein += codonTable[sequence.slice(index, index + 3)] ?? "X";
  }
  return protein;
}

function scanStrand(
  source: string,
  strand: "+" | "-",
  minAminoAcids: number,
  startMode: OrfStartMode,
  circular: boolean,
) {
  const length = source.length;
  const extended = circular ? source + source : source;
  const allowedStarts = startMode === "common" ? new Set(["ATG", "GTG", "TTG"]) : new Set(["ATG"]);
  const results: OpenReadingFrame[] = [];

  for (let frame = 0; frame < 3; frame += 1) {
    let activeStart: number | null = null;
    const scanLimit = circular ? length * 2 : length;

    for (let index = frame; index + 3 <= scanLimit; index += 3) {
      const codon = extended.slice(index, index + 3);

      if (activeStart === null && index < length && allowedStarts.has(codon)) {
        activeStart = index;
      }

      if (activeStart !== null && stopCodons.has(codon)) {
        const aminoAcidLength = (index - activeStart) / 3;
        const endExclusive = index + 3;
        const nucleotideLength = endExclusive - activeStart;

        if (aminoAcidLength >= minAminoAcids && nucleotideLength <= length) {
          const wrapsOrigin = endExclusive > length;
          const start = strand === "+"
            ? activeStart + 1
            : length - ((endExclusive - 1) % length);
          const end = strand === "+"
            ? ((endExclusive - 1) % length) + 1
            : length - activeStart;
          const dna = extended.slice(activeStart, index);
          const signedFrame = (strand === "+" ? frame + 1 : -(frame + 1)) as OpenReadingFrame["frame"];

          results.push({
            id: `${strand}-${frame}-${activeStart}-${endExclusive}`,
            start,
            end,
            strand,
            frame: signedFrame,
            aminoAcidLength,
            nucleotideLength,
            protein: translate(dna),
            wrapsOrigin,
          });
        }

        activeStart = null;
      }

      if (activeStart !== null && index - activeStart >= length) {
        activeStart = null;
      }
    }
  }

  return results;
}

export function findOpenReadingFrames(
  sequence: string,
  options: { minAminoAcids?: number; startMode?: OrfStartMode; circular?: boolean } = {},
) {
  const normalized = sequence.toUpperCase().replace(/U/g, "T");
  const minAminoAcids = Math.max(1, Math.floor(options.minAminoAcids ?? 50));
  const startMode = options.startMode ?? "atg";
  return [
    ...scanStrand(normalized, "+", minAminoAcids, startMode, Boolean(options.circular)),
    ...scanStrand(reverseComplement(normalized), "-", minAminoAcids, startMode, Boolean(options.circular)),
  ].sort((a, b) => b.aminoAcidLength - a.aminoAcidLength || a.start - b.start);
}

function motifPattern(motif: string) {
  return motif.split("").map((base) => iupacPattern[base] ?? "N").join("");
}

function motifPositions(sequence: string, motif: string, circular: boolean) {
  const extension = circular ? sequence.slice(0, motif.length - 1) : "";
  const searchable = sequence + extension;
  const expression = new RegExp(`(?=(${motifPattern(motif)}))`, "g");
  const positions: number[] = [];
  for (const match of searchable.matchAll(expression)) {
    const position = match.index ?? 0;
    if (position < sequence.length) positions.push(position);
  }
  return positions;
}

export function findRestrictionSites(
  sequence: string,
  enzymes: RestrictionEnzyme[] = RESTRICTION_ENZYMES,
  circular = false,
) {
  const normalized = sequence.toUpperCase().replace(/U/g, "T");
  const sites: RestrictionSite[] = [];

  for (const enzyme of enzymes) {
    const forwardMotif = enzyme.recognition;
    const reverseMotif = reverseComplement(forwardMotif);
    const orientations: Array<{ motif: string; strand: "+" | "-" }> = [{ motif: forwardMotif, strand: "+" }];
    if (reverseMotif !== forwardMotif) orientations.push({ motif: reverseMotif, strand: "-" });

    for (const orientation of orientations) {
      for (const zeroBased of motifPositions(normalized, orientation.motif, circular)) {
        const rawEnd = zeroBased + orientation.motif.length;
        sites.push({
          id: `${enzyme.name}-${orientation.strand}-${zeroBased}`,
          enzyme,
          position: zeroBased + 1,
          end: ((rawEnd - 1) % normalized.length) + 1,
          strand: orientation.strand,
          wrapsOrigin: rawEnd > normalized.length,
        });
      }
    }
  }

  return sites.sort((a, b) => a.position - b.position || a.enzyme.name.localeCompare(b.enzyme.name));
}
