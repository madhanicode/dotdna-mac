import assert from "node:assert/strict";
import test from "node:test";
import { applySequenceEdit } from "../app/sequence-edit.ts";

const feature = {
  name: "feature", type: "misc_feature", range: "3-6", color: "#ff9900", directionality: 1, strand: "+",
  segments: [{ range: "3-6", start: 3, end: 6, color: "#ff9900", name: null, type: "standard" }],
  qualifiers: [], readingFrame: null,
};

test("inserts DNA and remaps feature coordinates", () => {
  const result = applySequenceEdit("AACCGGTT", [feature], { kind: "insert", position: 4, sequence: "AAA" });
  assert.equal(result.sequence, "AACAAACGGTT");
  assert.equal(result.features[0].range, "3-9");
});

test("deletes covered features and shifts downstream features", () => {
  const downstream = { ...feature, range: "7-8", segments: [{ ...feature.segments[0], range: "7-8", start: 7, end: 8 }] };
  const result = applySequenceEdit("AACCGGTT", [feature, downstream], { kind: "delete", start: 3, end: 6 });
  assert.equal(result.sequence, "AATT");
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].range, "3-4");
});

test("reverse complements sequence, coordinates, and strand", () => {
  const result = applySequenceEdit("AACCGGTTAA", [feature], { kind: "reverse-complement" });
  assert.equal(result.sequence, "TTAACCGGTT");
  assert.equal(result.features[0].range, "5-8");
  assert.equal(result.features[0].strand, "-");
});
