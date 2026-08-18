import { describe, expect, it } from "vitest";
import { canSaveDocument, defaultProjectPath, directProjectPath, documentSavepoint, findOpenDocumentByPath, matchesDocumentSavepoint, nextUntitledName } from "./document-workflows";
import type { OpenDocument } from "./types";

function document(overrides: Partial<OpenDocument> = {}): OpenDocument {
  return {
    id: "test",
    path: null,
    format: "FASTA",
    fileVersion: null,
    document: {
      name: "sample.fasta",
      sequence: "ACGT",
      topology: "linear",
      double_stranded: true,
      features: [],
      primers: [],
      notes: { description: null, accession_number: null, comments: null, sequence_type: null },
      metadata: { primer_settings: {}, enzyme_visibilities: [], snapgene_packets: [] },
      history: [],
    },
    length: 4,
    gcPercent: 50,
    unknownBases: 0,
    diagnostics: [],
    dirty: false,
    view: "map",
    revision: 0,
    ...overrides,
  };
}

describe("document save workflows", () => {
  it("allows an imported clean document to be saved as a DOTDNA project", () => {
    expect(canSaveDocument(document(), false)).toBe(true);
    expect(directProjectPath(document())).toBeNull();
  });

  it("saves a dirty DOTDNA project in place and disables redundant clean saves", () => {
    const project = document({ format: "DOTDNA Project", path: "/tmp/sample.dotdna.json", dirty: true });
    expect(directProjectPath(project)).toBe("/tmp/sample.dotdna.json");
    expect(canSaveDocument(project, false)).toBe(true);
    expect(canSaveDocument({ ...project, dirty: false }, false)).toBe(false);
  });

  it("proposes a DOTDNA filename beside an imported source", () => {
    expect(defaultProjectPath(document({ path: "/tmp/sample.gbk" }))).toBe("/tmp/sample.dotdna.json");
  });

  it("generates collision-free untitled names", () => {
    expect(nextUntitledName(["Untitled DNA", "Untitled DNA 2"])).toBe("Untitled DNA 3");
  });

  it("finds an already-open canonical project path", () => {
    const open = document({ path: "/private/tmp/sample.dotdna.json", format: "DOTDNA Project" });
    expect(findOpenDocumentByPath([open], "/private/tmp/sample.dotdna.json")).toBe(open);
    expect(findOpenDocumentByPath([open], null)).toBeNull();
  });

  it("marks an undone sequence dirty when it differs from the saved checkpoint", () => {
    const saved = document({ document: { ...document().document, sequence: "AAAAGGGG" } });
    const savepoint = documentSavepoint(saved.document);
    const undone = { ...saved.document, sequence: "AAAACCCC" };
    expect(matchesDocumentSavepoint(savepoint, undone)).toBe(false);
    expect(matchesDocumentSavepoint(savepoint, saved.document)).toBe(true);
  });
});
