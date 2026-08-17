import type { SnapGeneData, SnapGeneFeature } from "./snapgene.ts";

export const WORKSPACE_RECOVERY_KEY = "dotdna.workspace-recovery.v1";

export type RecoveryAnnotation = SnapGeneFeature & {
  id: string;
  isCustom: boolean;
};

export type RecoveryHistoryEntry = {
  description: string;
  timestamp: string;
};

export type RecoverySnapshot = {
  data: SnapGeneData;
  customAnnotations: RecoveryAnnotation[];
  history: RecoveryHistoryEntry[];
};

export type RecoverableWorkspace = RecoverySnapshot & {
  fileName: string;
  importFormat: string;
  motif: string;
  undoStack: RecoverySnapshot[];
  redoStack: RecoverySnapshot[];
};

export type WorkspaceRecoveryRecord = {
  format: "dotdna-workspace-recovery";
  version: 1;
  savedAt: string;
  workspace: RecoverableWorkspace;
};

type OnDeviceRecoveryBridge = {
  load: () => Promise<unknown>;
  save: (record: WorkspaceRecoveryRecord) => Promise<void>;
  clear: () => Promise<void>;
};

declare global {
  interface Window {
    dotdnaRecovery?: OnDeviceRecoveryBridge;
  }
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
    && typeof entry.description === "string"
    && typeof entry.timestamp === "string");
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
  return isObject(value)
    && isSequenceData(value.data)
    && isAnnotations(value.customAnnotations)
    && isHistory(value.history);
}

function isWorkspace(value: unknown): value is RecoverableWorkspace {
  if (!isSnapshot(value)) return false;
  const candidate = value as unknown as Record<string, unknown>;
  return typeof candidate.fileName === "string"
    && candidate.fileName.length > 0
    && typeof candidate.importFormat === "string"
    && typeof candidate.motif === "string"
    && Array.isArray(candidate.undoStack)
    && candidate.undoStack.every(isSnapshot)
    && Array.isArray(candidate.redoStack)
    && candidate.redoStack.every(isSnapshot);
}

export function createWorkspaceRecovery(
  workspace: RecoverableWorkspace,
  savedAt = new Date().toISOString(),
): WorkspaceRecoveryRecord {
  return {
    format: "dotdna-workspace-recovery",
    version: 1,
    savedAt,
    workspace,
  };
}

export function parseWorkspaceRecovery(value: unknown): WorkspaceRecoveryRecord | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!isObject(candidate)
    || candidate.format !== "dotdna-workspace-recovery"
    || candidate.version !== 1
    || typeof candidate.savedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.savedAt))
    || !isWorkspace(candidate.workspace)) {
    return null;
  }
  return candidate as WorkspaceRecoveryRecord;
}

export async function loadWorkspaceRecovery(): Promise<WorkspaceRecoveryRecord | null> {
  if (typeof window === "undefined") return null;
  if (window.dotdnaRecovery) return parseWorkspaceRecovery(await window.dotdnaRecovery.load());
  try {
    return parseWorkspaceRecovery(window.localStorage.getItem(WORKSPACE_RECOVERY_KEY));
  } catch {
    return null;
  }
}

export async function saveWorkspaceRecovery(record: WorkspaceRecoveryRecord): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.dotdnaRecovery) {
    await window.dotdnaRecovery.save(record);
    return;
  }
  window.localStorage.setItem(WORKSPACE_RECOVERY_KEY, JSON.stringify(record));
}

export async function clearWorkspaceRecovery(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.dotdnaRecovery) {
    await window.dotdnaRecovery.clear();
    return;
  }
  window.localStorage.removeItem(WORKSPACE_RECOVERY_KEY);
}
