import { describe, expect, it } from "vitest";
import { canSaveDocument, defaultProjectPath, directProjectPath, documentSavepoint, findOpenDocumentByPath, matchesDocumentSavepoint, nativeMenuPayload, nativeMenuState, nextUntitledName } from "./document-workflows";
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

  it("enables only menu commands that can act on the current document", () => {
    expect(nativeMenuState({
      hasActiveDocument: true,
      activeBusy: false,
      activeCanSave: true,
      canUndo: true,
      canRedo: false,
      hasDraft: false,
      modalOpen: false,
      closeBusy: false,
      activeView: "sequence",
    })).toEqual({
      newDocument: true,
      openDocument: true,
      save: true,
      saveAs: true,
      close: true,
      undo: true,
      redo: false,
      changeView: true,
      activeView: "sequence",
    });
  });

  it("disables conflicting commands while a sequence draft is open", () => {
    const state = nativeMenuState({
      hasActiveDocument: true,
      activeBusy: false,
      activeCanSave: true,
      canUndo: true,
      canRedo: true,
      hasDraft: true,
      modalOpen: false,
      closeBusy: false,
      activeView: "sequence",
    });
    expect(state).toMatchObject({ newDocument: false, openDocument: false, save: false, saveAs: false, undo: false, redo: false, changeView: false });
    expect(state.close).toBe(false);
  });

  it("disables Close Document while a workflow sheet is active", () => {
    const state = nativeMenuState({
      hasActiveDocument: true,
      activeBusy: false,
      activeCanSave: true,
      canUndo: false,
      canRedo: false,
      hasDraft: false,
      modalOpen: true,
      closeBusy: false,
      activeView: "map",
    });
    expect(state.close).toBe(false);
    expect(state.newDocument).toBe(false);
    expect(state.changeView).toBe(false);
  });

  it("serializes enabled native menu item identifiers", () => {
    expect(nativeMenuPayload({
      newDocument: true,
      openDocument: true,
      save: false,
      saveAs: true,
      close: true,
      undo: true,
      redo: false,
      changeView: true,
      activeView: "features",
    })).toEqual({
      enabled: ["file.new", "file.open", "file.save-as", "file.close", "edit.undo-document", "view.map", "view.sequence", "view.features", "view.primers", "view.history"],
      activeView: "features",
    });
  });
});
