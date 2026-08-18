import type { DocumentView, OpenDocument, SequenceDocument } from "./types";

type SaveDocumentState = Pick<OpenDocument, "dirty" | "format" | "path" | "document">;

export type NativeMenuState = {
  newDocument: boolean;
  openDocument: boolean;
  save: boolean;
  saveAs: boolean;
  close: boolean;
  undo: boolean;
  redo: boolean;
  changeView: boolean;
  activeView: DocumentView | null;
};

const nativeViewIds: DocumentView[] = ["map", "sequence", "features", "primers", "history"];

export function nativeMenuPayload(state: NativeMenuState) {
  const enabled = [
    state.newDocument ? "file.new" : null,
    state.openDocument ? "file.open" : null,
    state.save ? "file.save" : null,
    state.saveAs ? "file.save-as" : null,
    state.close ? "file.close" : null,
    state.undo ? "edit.undo-document" : null,
    state.redo ? "edit.redo-document" : null,
    ...(state.changeView ? nativeViewIds.map((view) => `view.${view}`) : []),
  ].filter((id): id is string => id !== null);
  return { enabled, activeView: state.activeView };
}

export function nativeMenuState(input: {
  hasActiveDocument: boolean;
  activeBusy: boolean;
  activeCanSave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasDraft: boolean;
  modalOpen: boolean;
  closeBusy: boolean;
  activeView: DocumentView | null;
}): NativeMenuState {
  const blocked = input.modalOpen || input.hasDraft;
  return {
    newDocument: !blocked,
    openDocument: !blocked,
    save: !blocked && input.hasActiveDocument && input.activeCanSave,
    saveAs: !blocked && input.hasActiveDocument && !input.activeBusy,
    close: !blocked && !input.closeBusy && input.hasActiveDocument && !input.activeBusy,
    undo: !blocked && input.canUndo,
    redo: !blocked && input.canRedo,
    changeView: !blocked && input.hasActiveDocument,
    activeView: input.activeView,
  };
}

export function directProjectPath(document: SaveDocumentState) {
  return document.format === "DOTDNA Project" && document.path ? document.path : null;
}

export function canSaveDocument(document: SaveDocumentState | null, busy: boolean) {
  if (!document || busy) return false;
  return document.dirty || directProjectPath(document) === null;
}

export function findOpenDocumentByPath(documents: OpenDocument[], path: string | null) {
  return path ? documents.find((document) => document.path === path) ?? null : null;
}

export function documentSavepoint(document: SequenceDocument) {
  return JSON.stringify(document);
}

export function matchesDocumentSavepoint(savepoint: string | null | undefined, document: SequenceDocument) {
  return savepoint != null && savepoint === documentSavepoint(document);
}

function projectStem(name: string) {
  return name
    .trim()
    .replace(/\.(?:dotdna\.json|dna|gbk?|fasta?|json|txt)$/i, "") || "Untitled DNA";
}

export function defaultProjectPath(document: SaveDocumentState) {
  if (document.path) {
    const separator = document.path.lastIndexOf("/");
    const directory = separator >= 0 ? document.path.slice(0, separator + 1) : "";
    const fileName = separator >= 0 ? document.path.slice(separator + 1) : document.path;
    return `${directory}${projectStem(fileName)}.dotdna.json`;
  }
  return `${projectStem(document.document.name)}.dotdna.json`;
}

export function nextUntitledName(names: string[]) {
  const existing = new Set(names.map((name) => name.toLowerCase()));
  if (!existing.has("untitled dna")) return "Untitled DNA";
  let suffix = 2;
  while (existing.has(`untitled dna ${suffix}`)) suffix += 1;
  return `Untitled DNA ${suffix}`;
}
