export type Topology = "linear" | "circular";
export type Strand = "forward" | "reverse" | "both" | "none";

export type SequenceSpan = {
  start: number;
  end: number;
};

export type FeatureSegment = {
  span: SequenceSpan;
  color: string | null;
  name: string | null;
  kind: string | null;
};

export type Qualifier = {
  name: string;
  value: string;
};

export type Feature = {
  id?: string | null;
  name: string;
  kind: string;
  color: string | null;
  strand: Strand;
  segments: FeatureSegment[];
  qualifiers: Qualifier[];
  reading_frame: number | null;
};

export type PrimerBindingSite = {
  span: SequenceSpan;
  strand: Strand;
};

export type Primer = {
  id?: string | null;
  name: string;
  sequence: string;
  binding_length: number | null;
  description: string | null;
  color: string | null;
  phosphorylated: boolean;
  binding_sites: PrimerBindingSite[];
};

export type HistoryEntry = {
  operation: string;
  description: string;
  recorded_at: string;
  parent_document?: SequenceDocument | null;
};

export type SequenceDocument = {
  name: string;
  sequence: string;
  topology: Topology;
  double_stranded: boolean;
  features: Feature[];
  primers: Primer[];
  notes: {
    description: string | null;
    accession_number: string | null;
    comments: string | null;
    sequence_type: string | null;
    [key: string]: unknown;
  };
  metadata: {
    primer_settings: Record<string, string>;
    enzyme_visibilities: string[];
    snapgene_packets: unknown[];
    [key: string]: unknown;
  };
  history: HistoryEntry[];
};

export type DocumentSummary = {
  path: string | null;
  format: string;
  fileVersion: string | null;
  document: SequenceDocument;
  length: number;
  gcPercent: number;
  unknownBases: number;
  diagnostics: Array<{
    severity: "error" | "warning";
    code: string;
    message: string;
    action: string;
  }>;
};

export type ProjectFolderFile = {
  path: string;
  relativePath: string;
  name: string;
  format: string;
  byteLength: number;
};

export type ProjectFolderSummary = {
  path: string;
  name: string;
  files: ProjectFolderFile[];
  truncated: boolean;
  warnings: string[];
};

export type DocumentView = "map" | "sequence" | "features" | "primers" | "history";

export type OpenDocument = DocumentSummary & {
  id: string;
  dirty: boolean;
  view: DocumentView;
  revision: number;
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

export type PrimerBinding = {
  span: SequenceSpan;
  strand: "+" | "-";
  wrapsOrigin: boolean;
  bindingLength: number;
  tailLength: number;
  bindingSequence: string;
  tailSequence: string;
  templateSequence: string;
  mismatchCount: number;
  mismatches: Array<{ primerIndex: number; primerBase: string; templateBase: string }>;
  threePrimeMatchLength: number;
  meltingTemperature: number;
};

export type PrimerCheck = {
  name: string;
  status: "validated" | "needs-binding-region" | "invalid" | "no-binding" | "multiple-bindings";
  headline: string;
  action: string | null;
  analysis: PrimerAnalysis | null;
  bindings: PrimerBinding[];
  bindingsTruncated: boolean;
};

export type PcrProduct = {
  mode: "standard" | "inverse" | "overlap-extension";
  sequence: string;
  templateStart: number;
  templateEnd: number;
  length: number;
  gcPercent: number;
  wrapsOrigin: boolean;
  forwardBinding: PrimerBinding;
  reverseBinding: PrimerBinding;
  features: Array<{
    name: string;
    featureType: "primer" | "tail" | "mutation" | "overlap";
    span: SequenceSpan;
    strand: Strand;
    note: string | null;
  }>;
  warnings: string[];
  overlapLength: number | null;
};

export type PcrCommandResult = {
  product: PcrProduct;
  document: DocumentSummary;
};

export type CommandError = {
  code: string;
  message: string;
  action: string;
};

export type TranslatedCodon = {
  center: number;
  aminoAcid: string;
  kind: "start" | "stop" | "amino" | "ambiguous";
};

export type OpenReadingFrame = {
  id: string;
  intervals: SequenceSpan[];
  strand: "forward" | "reverse";
  frame: number;
  wrapsOrigin: boolean;
  nucleotideLength: number;
  aminoAcidLength: number;
  codingStart: number;
  codingStop: number;
};

export type OrfTranslation = {
  orfId: string;
  strand: "forward" | "reverse";
  frame: number;
  aminoAcids: string;
  codons: TranslatedCodon[];
};
