import assert from "node:assert/strict";
import test from "node:test";
import { buildAnnotatedSequenceRows, featureIntervals, featuresOverlappingRange, motifBasePositions } from "../app/annotated-sequence.ts";

const feature = (name, start, end, color = "#17b6c9") => ({
  name,
  type: "misc_feature",
  range: `${start}-${end}`,
  color,
  directionality: 1,
  strand: "+",
  segments: [{ range: `${start}-${end}`, start, end, color, name: null, type: "standard" }],
  qualifiers: [],
  readingFrame: null,
});

test("splits annotations across fixed-width sequence rows", () => {
  const rows = buildAnnotatedSequenceRows("A".repeat(120), [feature("cross-row", 55, 70)], 60);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].annotations.map(({ start, end }) => [start, end]), [[55, 60]]);
  assert.deepEqual(rows[1].annotations.map(({ start, end }) => [start, end]), [[61, 70]]);
});

test("assigns overlapping annotations to separate lanes", () => {
  const [row] = buildAnnotatedSequenceRows("A".repeat(60), [feature("one", 5, 20), feature("two", 15, 30)], 60);
  assert.equal(row.laneCount, 2);
  assert.deepEqual(row.annotations.map(({ lane }) => lane), [0, 1]);
});

test("places feature, primer, restriction, and ORF overlays in the same row model", () => {
  const overlays = [
    { id: "primer-1", kind: "primer", name: "Fwd", color: "#7755cc", strand: "+", start: 10, end: 25 },
    { id: "site-1", kind: "restriction", name: "EcoRI", color: "#0f8278", strand: "+", start: 20, end: 25 },
    { id: "orf-1", kind: "orf", name: "ORF +1", color: "#ef9e38", strand: "+", start: 30, end: 55 },
  ];
  const [row] = buildAnnotatedSequenceRows("A".repeat(60), [feature("gene", 1, 12)], 60, overlays);
  assert.deepEqual([...new Set(row.annotations.map(({ kind }) => kind))], ["feature", "primer", "restriction", "orf"]);
  assert.equal(row.laneCount >= 2, true);
});

test("expands an origin-wrapping segment into two intervals", () => {
  assert.deepEqual(featureIntervals(feature("wrap", 90, 10), 100).map(({ start, end }) => [start, end]), [[90, 100], [1, 10]]);
});

test("finds selected annotations and all bases in overlapping motif hits", () => {
  const features = [feature("left", 3, 8), feature("right", 20, 25)];
  assert.deepEqual(featuresOverlappingRange(features, 30, 7, 12).map(({ name }) => name), ["left"]);
  assert.deepEqual([...motifBasePositions("AAAA", "AAA")], [1, 2, 3, 4]);
});
