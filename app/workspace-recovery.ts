import type { OrfSortKey, RestrictionSortKey, SortDirection } from "./analysis-sort.ts";
import type { OrfStartMode } from "./sequence-analysis.ts";
import type { SnapGeneData, SnapGeneFeature } from "./snapgene.ts";

export const WORKSPACE_RECOVERY_KEY = "dotdna.workspace-recovery.v2";
const LEGACY_WORKSPACE_RECOVERY_KEY = "dotdna.workspace-recovery.v1";
export const MAX_RECOVERY_RECORDS = 10;

export type RecoveryAnnotation = SnapGeneFeature & { id: string; isCustom: boolean };
export type RecoveryHistoryEntry = { description: string; timestamp: string };
export type RecoverySnapshot = { data: SnapGeneData; customAnnotations: RecoveryAnnotation[]; history: RecoveryHistoryEntry[] };

export type WorkspaceUiState = {
  workspaceView: "split" | "sequence" | "plasmid";
  selection: { start: number; end: number } | null;
  caret: number;
  windowScrollY: number;
  sequenceScrollTop: number;
  molecularTab: "primers" | "design" | "pcr" | "translation";
  designTab: "assembly" | "alignment";
  primerSort: { key: "name" | "sequence" | "length" | "tm" | "gc" | "bindings"; direction: SortDirection };
  packetSort: { key: "index" | "name" | "type" | "format" | "size" | "status"; direction: SortDirection };
  annotationSort: { key: "name" | "type" | "start" | "length"; direction: SortDirection };
  analysis: {
    minimumAminoAcids: number;
    startMode: OrfStartMode;
    enzymeQuery: string;
    cutterMode: "all" | "unique" | "double" | "type-iis";
    orfSort: { key: OrfSortKey; direction: SortDirection };
    restrictionSort: { key: RestrictionSortKey; direction: SortDirection };
  };
};

export const DEFAULT_WORKSPACE_UI_STATE: WorkspaceUiState = {
  workspaceView: "split",
  selection: null,
  caret: 1,
  windowScrollY: 0,
  sequenceScrollTop: 0,
  molecularTab: "primers",
  designTab: "assembly",
  primerSort: { key: "name", direction: "asc" },
  packetSort: { key: "index", direction: "asc" },
  annotationSort: { key: "start", direction: "asc" },
  analysis: {
    minimumAminoAcids: 50,
    startMode: "atg",
    enzymeQuery: "",
    cutterMode: "all",
    orfSort: { key: "length", direction: "desc" },
    restrictionSort: { key: "enzyme", direction: "asc" },
  },
};

export type RecoverableWorkspace = RecoverySnapshot & {
  fileName: string;
  importFormat: string;
  motif: string;
  undoStack: RecoverySnapshot[];
  redoStack: RecoverySnapshot[];
  ui: WorkspaceUiState;
};

export type WorkspaceRecoveryRecord = {
  format: "dotdna-workspace-recovery";
  version: 2;
  savedAt: string;
  workspace: RecoverableWorkspace;
};

type RecoveryArchive = { format: "dotdna-recovery-history"; version: 1; records: WorkspaceRecoveryRecord[] };
type OnDeviceRecoveryBridge = {
  load: () => Promise<unknown>;
  list: () => Promise<unknown>;
  save: (record: WorkspaceRecoveryRecord) => Promise<void>;
  clear: (savedAt?: string) => Promise<void>;
};

declare global {
  interface Window { dotdnaRecovery?: OnDeviceRecoveryBridge }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSequenceData(value: unknown): value is SnapGeneData {
  if (!isObject(value)) return false;
  return typeof value.sequence === "string"
    && value.sequence.length > 0
    && value.length === value.sequence.length
    && typeof value.circular === "boolean"
    && typeof value.doubleStranded === "boolean"
    && Array.isArray(value.features)
    && Array.isArray(value.primers);
}

function isHistory(value: unknown): value is RecoveryHistoryEntry[] {
  return Array.isArray(value) && value.every((entry) => isObject(entry)
    && typeof entry.description === "string" && typeof entry.timestamp === "string");
}

function isAnnotations(value: unknown): value is RecoveryAnnotation[] {
  return Array.isArray(value) && value.every((annotation) => isObject(annotation)
    && typeof annotation.id === "string"
    && typeof annotation.isCustom === "boolean"
    && typeof annotation.name === "string"
    && Array.isArray(annotation.segments)
    && Array.isArray(annotation.qualifiers));
}

function isSnapshot(value: unknown): value is RecoverySnapshot {
  return isObject(value) && isSequenceData(value.data) && isAnnotations(value.customAnnotations) && isHistory(value.history);
}

function isSort(value: unknown, keys: readonly string[]) {
  return isObject(value)
    && typeof value.key === "string"
    && keys.includes(value.key)
    && (value.direction === "asc" || value.direction === "desc");
}

function isUiState(value: unknown): value is WorkspaceUiState {
  if (!isObject(value) || !isObject(value.analysis)) return false;
  const selection = value.selection;
  return ["split", "sequence", "plasmid"].includes(String(value.workspaceView))
    && (selection === null || (isObject(selection) && Number.isInteger(selection.start) && Number.isInteger(selection.end)))
    && Number.isInteger(value.caret)
    && typeof value.windowScrollY === "number"
    && typeof value.sequenceScrollTop === "number"
    && ["primers", "design", "pcr", "translation"].includes(String(value.molecularTab))
    && ["assembly", "alignment"].includes(String(value.designTab))
    && isSort(value.primerSort, ["name", "sequence", "length", "tm", "gc", "bindings"])
    && isSort(value.packetSort, ["index", "name", "type", "format", "size", "status"])
    && isSort(value.annotationSort, ["name", "type", "start", "length"])
    && typeof value.analysis.minimumAminoAcids === "number"
    && ["atg", "common"].includes(String(value.analysis.startMode))
    && typeof value.analysis.enzymeQuery === "string"
    && ["all", "unique", "double", "type-iis"].includes(String(value.analysis.cutterMode))
    && isSort(value.analysis.orfSort, ["frame", "range", "length", "protein"])
    && isSort(value.analysis.restrictionSort, ["enzyme", "recognition", "sites", "coordinates"]);
}

function normalizeWorkspace(value: unknown): RecoverableWorkspace | null {
  if (!isSnapshot(value)) return null;
  const candidate = value as unknown as Record<string, unknown>;
  if (typeof candidate.fileName !== "string" || !candidate.fileName
    || typeof candidate.importFormat !== "string"
    || typeof candidate.motif !== "string"
    || !Array.isArray(candidate.undoStack) || !candidate.undoStack.every(isSnapshot)
    || !Array.isArray(candidate.redoStack) || !candidate.redoStack.every(isSnapshot)) return null;
  return {
    ...(value as RecoverySnapshot),
    fileName: candidate.fileName,
    importFormat: candidate.importFormat,
    motif: candidate.motif,
    undoStack: candidate.undoStack as RecoverySnapshot[],
    redoStack: candidate.redoStack as RecoverySnapshot[],
    ui: isUiState(candidate.ui) ? candidate.ui : structuredClone(DEFAULT_WORKSPACE_UI_STATE),
  };
}

export function createWorkspaceRecovery(workspace: RecoverableWorkspace, savedAt = new Date().toISOString()): WorkspaceRecoveryRecord {
  return { format: "dotdna-workspace-recovery", version: 2, savedAt, workspace };
}

export function parseWorkspaceRecovery(value: unknown): WorkspaceRecoveryRecord | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { return null; }
  }
  if (!isObject(candidate)
    || candidate.format !== "dotdna-workspace-recovery"
    || (candidate.version !== 1 && candidate.version !== 2)
    || typeof candidate.savedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.savedAt))) return null;
  const workspace = normalizeWorkspace(candidate.workspace);
  return workspace ? createWorkspaceRecovery(workspace, candidate.savedAt) : null;
}

export function parseWorkspaceRecoveryList(value: unknown): WorkspaceRecoveryRecord[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { return []; }
  }
  const values = isObject(candidate)
    && candidate.format === "dotdna-recovery-history"
    && candidate.version === 1
    && Array.isArray(candidate.records)
    ? candidate.records
    : [candidate];
  return values
    .map(parseWorkspaceRecovery)
    .filter((record): record is WorkspaceRecoveryRecord => Boolean(record))
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt))
    .slice(0, MAX_RECOVERY_RECORDS);
}

function archive(records: WorkspaceRecoveryRecord[]): RecoveryArchive {
  return { format: "dotdna-recovery-history", version: 1, records: records.slice(0, MAX_RECOVERY_RECORDS) };
}

export function mergeWorkspaceRecovery(records: WorkspaceRecoveryRecord[], record: WorkspaceRecoveryRecord) {
  const latest = records[0];
  const sameCheckpoint = latest
    && latest.workspace.fileName === record.workspace.fileName
    && latest.workspace.history.length === record.workspace.history.length
    && latest.workspace.data.sequence === record.workspace.data.sequence;
  const previous = sameCheckpoint ? records.slice(1) : records;
  return [record, ...previous.filter(({ savedAt }) => savedAt !== record.savedAt)].slice(0, MAX_RECOVERY_RECORDS);
}

export async function loadWorkspaceRecoveries(): Promise<WorkspaceRecoveryRecord[]> {
  if (typeof window === "undefined") return [];
  if (window.dotdnaRecovery) return parseWorkspaceRecoveryList(await window.dotdnaRecovery.list());
  try {
    const current = window.localStorage.getItem(WORKSPACE_RECOVERY_KEY);
    if (current) return parseWorkspaceRecoveryList(current);
    return parseWorkspaceRecoveryList(window.localStorage.getItem(LEGACY_WORKSPACE_RECOVERY_KEY));
  } catch { return []; }
}

export async function loadWorkspaceRecovery(): Promise<WorkspaceRecoveryRecord | null> {
  if (typeof window === "undefined") return null;
  if (window.dotdnaRecovery) return parseWorkspaceRecovery(await window.dotdnaRecovery.load());
  return (await loadWorkspaceRecoveries())[0] ?? null;
}

export async function saveWorkspaceRecovery(record: WorkspaceRecoveryRecord): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.dotdnaRecovery) {
    await window.dotdnaRecovery.save(record);
    return;
  }
  const records = await loadWorkspaceRecoveries();
  const next = mergeWorkspaceRecovery(records, record);
  window.localStorage.setItem(WORKSPACE_RECOVERY_KEY, JSON.stringify(archive(next)));
  window.localStorage.removeItem(LEGACY_WORKSPACE_RECOVERY_KEY);
}

export async function clearWorkspaceRecovery(savedAt?: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.dotdnaRecovery) {
    await window.dotdnaRecovery.clear(savedAt);
    return;
  }
  if (!savedAt) {
    window.localStorage.removeItem(WORKSPACE_RECOVERY_KEY);
    window.localStorage.removeItem(LEGACY_WORKSPACE_RECOVERY_KEY);
    return;
  }
  const records = (await loadWorkspaceRecoveries()).filter((record) => record.savedAt !== savedAt);
  if (records.length) window.localStorage.setItem(WORKSPACE_RECOVERY_KEY, JSON.stringify(archive(records)));
  else window.localStorage.removeItem(WORKSPACE_RECOVERY_KEY);
}
