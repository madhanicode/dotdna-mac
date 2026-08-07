import assert from "node:assert/strict";
import test from "node:test";
import {
  findOpenReadingFrames,
  findRestrictionSites,
  RESTRICTION_ENZYMES,
  reverseComplement,
} from "../app/sequence-analysis.ts";

test("finds forward and reverse open reading frames", () => {
  const forward = findOpenReadingFrames("ATGAAATAA", { minAminoAcids: 2 });
  assert.equal(forward.length, 1);
  assert.deepEqual(
    { start: forward[0].start, end: forward[0].end, frame: forward[0].frame, protein: forward[0].protein },
    { start: 1, end: 9, frame: 1, protein: "MK" },
  );

  const reverse = findOpenReadingFrames(reverseComplement("ATGAAATAA"), { minAminoAcids: 2 });
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].strand, "-");
  assert.equal(reverse[0].aminoAcidLength, 2);
});

test("finds palindromic and directional restriction sites", () => {
  const enzymes = RESTRICTION_ENZYMES.filter(({ name }) => name === "EcoRI" || name === "BsaI");
  const sites = findRestrictionSites("AAAAGAATTCTTTGGTCTCAAA", enzymes);
  assert.deepEqual(sites.map((site) => [site.enzyme.name, site.position, site.strand]), [
    ["EcoRI", 5, "+"],
    ["BsaI", 14, "+"],
  ]);
});

test("finds a restriction site that crosses a circular origin", () => {
  const ecoRI = RESTRICTION_ENZYMES.filter(({ name }) => name === "EcoRI");
  const sites = findRestrictionSites("AATTCAAAAG", ecoRI, true);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].position, 10);
  assert.equal(sites[0].wrapsOrigin, true);
});
