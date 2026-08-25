import assert from "node:assert/strict";
import test from "node:test";
import { parseTextSequence } from "../app/sequence-formats.ts";
import {
  DEFAULT_WORKSPACE_UI_STATE,
  createWorkspaceRecovery,
  mergeWorkspaceRecovery,
  parseWorkspaceRecovery,
  parseWorkspaceRecoveryList,
} from "../app/workspace-recovery.ts";

function workspace(sequence = "ACGTACGT") {
  const data = parseTextSequence("demo.fa", `>demo\n${sequence}`).data;
  const annotation = {
    name: "local edit",
    type: "misc_feature",
    range: "2-5",
    color: "#17b6c9",
    directionality: 1,
    strand: "+",
    segments: [{ range: "2-5", start: 2, end: 5, color: "#17b6c9", name: null, type: "standard" }],
    qualifiers: [],
    readingFrame: null,
    id: "added-test",
    isCustom: true,
  };
  const snapshot = {
    data,
    customAnnotations: [annotation],
    history: [{ description: "Added annotation local edit", timestamp: "10:30 AM" }],
  };
  return {
    ...snapshot,
    fileName: "demo.dna",
    importFormat: "FASTA",
    motif: "ACG",
    undoStack: [snapshot],
    redoStack: [],
    ui: structuredClone(DEFAULT_WORKSPACE_UI_STATE),
  };
}

test("round-trips the open workspace, edits, and undo history", () => {
  const record = createWorkspaceRecovery(workspace(), "2026-08-16T17:30:00.000Z");
  const restored = parseWorkspaceRecovery(JSON.stringify(record));

  assert.equal(restored?.savedAt, "2026-08-16T17:30:00.000Z");
  assert.equal(restored?.workspace.fileName, "demo.dna");
  assert.equal(restored?.workspace.data.sequence, "ACGTACGT");
  assert.equal(restored?.workspace.customAnnotations[0].name, "local edit");
  assert.equal(restored?.workspace.undoStack.length, 1);
  assert.equal(restored?.workspace.motif, "ACG");
  assert.deepEqual(restored?.workspace.ui.selection, null);
});

test("migrates v1 snapshots with safe UI defaults", () => {
  const record = createWorkspaceRecovery(workspace(), "2026-08-16T17:30:00.000Z");
  const legacy = { ...record, version: 1, workspace: { ...record.workspace } };
  delete legacy.workspace.ui;
  const restored = parseWorkspaceRecovery(legacy);
  assert.equal(restored?.version, 2);
  assert.equal(restored?.workspace.ui.workspaceView, "split");
  assert.equal(restored?.workspace.ui.analysis.minimumAminoAcids, 50);
});

test("keeps ten checkpoints and replaces UI-only saves at the latest checkpoint", () => {
  let records = [];
  for (let index = 0; index < 12; index += 1) {
    const nextWorkspace = workspace(`ACGTACG${index % 10}`);
    nextWorkspace.history = Array.from({ length: index }, (_, item) => ({ description: `Edit ${item}`, timestamp: "10:30 AM" }));
    records = mergeWorkspaceRecovery(records, createWorkspaceRecovery(nextWorkspace, `2026-08-${String(index + 1).padStart(2, "0")}T17:30:00.000Z`));
  }
  assert.equal(records.length, 10);
  const latest = records[0];
  const uiOnly = createWorkspaceRecovery({ ...latest.workspace, ui: { ...latest.workspace.ui, windowScrollY: 900 } }, "2026-09-01T17:30:00.000Z");
  const merged = mergeWorkspaceRecovery(records, uiOnly);
  assert.equal(merged.length, 10);
  assert.equal(merged[0].workspace.ui.windowScrollY, 900);
  assert.equal(parseWorkspaceRecoveryList({ format: "dotdna-recovery-history", version: 1, records: merged }).length, 10);
});

test("rejects malformed, incompatible, or internally inconsistent recovery data", () => {
  const record = createWorkspaceRecovery(workspace(), "2026-08-16T17:30:00.000Z");

  assert.equal(parseWorkspaceRecovery("not json"), null);
  assert.equal(parseWorkspaceRecovery({ ...record, version: 99 }), null);
  assert.equal(parseWorkspaceRecovery({ ...record, workspace: { ...record.workspace, undoStack: [{}] } }), null);
  assert.equal(parseWorkspaceRecovery({
    ...record,
    workspace: { ...record.workspace, data: { ...record.workspace.data, length: 99 } },
  }), null);
});
