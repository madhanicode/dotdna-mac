import assert from "node:assert/strict";
import test from "node:test";
import { parseTextSequence } from "../app/sequence-formats.ts";
import {
  createWorkspaceRecovery,
  parseWorkspaceRecovery,
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
});

test("rejects malformed, incompatible, or internally inconsistent recovery data", () => {
  const record = createWorkspaceRecovery(workspace(), "2026-08-16T17:30:00.000Z");

  assert.equal(parseWorkspaceRecovery("not json"), null);
  assert.equal(parseWorkspaceRecovery({ ...record, version: 2 }), null);
  assert.equal(parseWorkspaceRecovery({ ...record, workspace: { ...record.workspace, undoStack: [{}] } }), null);
  assert.equal(parseWorkspaceRecovery({
    ...record,
    workspace: { ...record.workspace, data: { ...record.workspace.data, length: 99 } },
  }), null);
});
