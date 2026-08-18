import type { OpenDocument, SequenceDocument } from "./types";

type SaveDocumentState = Pick<OpenDocument, "dirty" | "format" | "path" | "document">;

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
