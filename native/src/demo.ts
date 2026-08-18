import type { DocumentSummary, Feature, SequenceDocument } from "./types";

const seed = "ATGACCATGATTACGCCAAGCTTGCTAGCGGATCCGGTACCGAGCTCGAATTCGTAATCATGGTCATAGCTGTTTCCTGTGTGAAATTGTTATCCGCTCACAATTCCACACAACATACGAGCCGGAAGCATAAAGTGTAAAGCCTGGGGTGCCTAATGAGTGAGCTAACTCACATTAATTGCGTTGCGCTCACTGCCCGCTTTCCAGTCGGGAAACCTGTCGTGCCAGCTGCATTAATGAATCGGCCAACGCGCGGGGAGAGGCGGTTTGCGTATTGGGCGCTCTTCCGCTTCCTCGCTCACTGACTCGCTGCGCTCGGTCGTTCGGCTGCGGCGAGCGGTATCAGCTCACTCAAAGGCGGTAATACGGTTATCCACAGAATCAGGGGATAACGCAGGAAAGAACATGTGAGCAAAAGGCCAGCAAAAGGCCAGGAACCGTAAAAAGGCCGCGTTGCTGGCGTTTTTCCATAGGCTCCGCCCCCCTGACGAGCATCACAAAAATCGACGCTCAAGTCAGAGGTGGCGAAACCCGACAGGACTATAAAGATACCAGGCGTTTCCCCCTGGAAGCTCCCTCGTGCGCTCTCCTGTTCCGACCCTGCCGCTTACCGGATACCTGTCCGCCTTTCTCCCTTCGGGAAGCGTGGCGCTTTCTCA";

function repeatedSequence(length: number) {
  let state = 0x4d3c2b1a ^ seed.length;
  const bases = "ACGT";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    result += bases[state >>> 30];
  }
  return result;
}

function reverseComplement(value: string) {
  const complement: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
  return [...value].reverse().map((base) => complement[base]).join("");
}

function feature(name: string, kind: string, start: number, end: number, color: string, strand: Feature["strand"] = "forward"): Feature {
  return {
    name,
    kind,
    color,
    strand,
    segments: [{ span: { start, end }, color, name: null, kind: "standard" }],
    qualifiers: [{ name: "label", value: name }],
    reading_frame: kind === "CDS" ? 0 : null,
  };
}

const sequence = repeatedSequence(5420);
const gcPercent = [...sequence].filter((base) => base === "G" || base === "C").length / sequence.length * 100;
const forwardBinding = sequence.slice(2694, 2716);
const reverseBinding = sequence.slice(3390, 3413);

export const demoDocument: DocumentSummary = {
  path: null,
  format: "DOTDNA Demo",
  length: sequence.length,
  gcPercent,
  unknownBases: 0,
  diagnostics: [],
  document: {
    name: "DOTDNA Demo.dna",
    sequence,
    topology: "circular",
    double_stranded: true,
    features: [
      feature("AmpR", "CDS", 310, 1170, "#ef675f", "reverse"),
      feature("pUC origin", "rep_origin", 1350, 2035, "#6f92db"),
      feature("lac promoter", "promoter", 2260, 2412, "#ae7ad8"),
      feature("MCS", "misc_feature", 2440, 2602, "#e0bd55"),
      feature("mNeonGreen", "CDS", 2700, 3411, "#69c986"),
      feature("SV40 poly(A)", "terminator", 3530, 3805, "#4fb6c7"),
      feature("KanR", "CDS", 4010, 4815, "#ee8d4e"),
    ],
    primers: [
      {
        name: "mNG_Fwd",
        sequence: `GGTCTC${forwardBinding}`,
        binding_length: 22,
        description: "BsaI tail + template-binding region",
        color: "#79d6e5",
        phosphorylated: false,
        binding_sites: [{ span: { start: 2694, end: 2716 }, strand: "forward" }],
      },
      {
        name: "mNG_Rev",
        sequence: `GGTCTC${reverseComplement(reverseBinding)}`,
        binding_length: 23,
        description: "BsaI tail + template-binding region",
        color: "#f2a76e",
        phosphorylated: false,
        binding_sites: [{ span: { start: 3390, end: 3413 }, strand: "reverse" }],
      },
    ],
    notes: {
      description: "Demonstration plasmid for the DOTDNA desktop workbench.",
      accession_number: null,
      comments: "Open a SnapGene, GenBank, FASTA, or DOTDNA project to replace this example.",
      sequence_type: "Synthetic",
    },
    metadata: {
      primer_settings: {},
      enzyme_visibilities: [],
      snapgene_packets: [],
    },
    history: [
      { operation: "import", description: "Created DOTDNA demonstration document", recorded_at: "Today, 8:41 PM" },
      { operation: "primer", description: "Added mutagenesis-ready mNeonGreen primers", recorded_at: "Today, 8:44 PM" },
    ],
  } satisfies SequenceDocument,
};
