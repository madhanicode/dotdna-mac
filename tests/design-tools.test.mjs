import assert from "node:assert/strict";
import test from "node:test";
import { alignDnaGlobal, assembleByExactOverlap, formatPairwiseAlignment, parseAssemblyFragments } from "../app/design-tools.ts";

test("parses FASTA fragments and assembles exact overlaps", () => {
  const fragments = parseAssemblyFragments(">left\nAAAACCCC\n>right\nCCCCGGGG");
  const result = assembleByExactOverlap(fragments, { minimumOverlap: 4 });
  assert.equal(result.sequence, "AAAACCCCGGGG");
  assert.equal(result.junctions[0].overlap, 4);
  assert.equal(result.fragments[1].reverseComplemented, false);
});

test("automatically uses the reverse-complemented fragment when it gives the overlap", () => {
  const result = assembleByExactOverlap([
    { name: "left", sequence: "AAAACCCC" },
    { name: "right", sequence: "AAAATTTTGGGG" },
  ], { minimumOverlap: 4 });
  assert.equal(result.fragments[1].reverseComplemented, true);
  assert.equal(result.sequence, "AAAACCCCAAAATTTT");
});

test("circular assembly removes the terminal closure overlap", () => {
  const result = assembleByExactOverlap([
    { name: "one", sequence: "AAAACCCC" },
    { name: "two", sequence: "CCCCGGGGAAAA" },
  ], { minimumOverlap: 4, circular: true });
  assert.equal(result.sequence, "AAAACCCCGGGG");
  assert.equal(result.junctions.at(-1).closure, true);
});

test("performs a deterministic Needleman-Wunsch global DNA alignment", () => {
  const alignment = alignDnaGlobal("ACGT", "AGT");
  assert.equal(alignment.alignedReference, "ACGT");
  assert.equal(alignment.alignedQuery, "A-GT");
  assert.equal(alignment.matches, 3);
  assert.equal(alignment.gaps, 1);
  assert.equal(alignment.identityPercent, 75);
  assert.match(formatPairwiseAlignment(alignment), /Reference\s+ACGT/);
});
