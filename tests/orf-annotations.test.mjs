import assert from "node:assert/strict";
import test from "node:test";
import { createOrfCdsFeature, featureMatchesOrf, ORF_ID_QUALIFIER } from "../app/orf-annotations.ts";

const orf = {
  id: "+-1-3-15",
  start: 4,
  end: 15,
  strand: "+",
  frame: 1,
  aminoAcidLength: 3,
  nucleotideLength: 12,
  protein: "MKT",
  wrapsOrigin: false,
};

test("creates a CDS that remains linked to its predicted ORF", () => {
  const feature = createOrfCdsFeature(orf, 30);

  assert.equal(feature.type, "CDS");
  assert.equal(feature.range, "4-15");
  assert.equal(feature.qualifiers.find(({ name }) => name === ORF_ID_QUALIFIER)?.value, orf.id);
  assert.equal(featureMatchesOrf(feature, orf, 30), true);
  assert.equal(featureMatchesOrf(feature, { ...orf, id: "different", start: 7 }, 30), false);
});

test("recognizes existing coordinate-matched CDS annotations and origin-spanning CDS features", () => {
  const untagged = { ...createOrfCdsFeature(orf, 30), qualifiers: [] };
  assert.equal(featureMatchesOrf(untagged, orf, 30), true);

  const wrapping = { ...orf, id: "+-1-24-6", start: 25, end: 6, wrapsOrigin: true };
  const feature = createOrfCdsFeature(wrapping, 30);
  assert.deepEqual(feature.segments.map(({ start, end }) => [start, end]), [[25, 30], [1, 6]]);
  assert.equal(featureMatchesOrf(feature, wrapping, 30), true);
});
