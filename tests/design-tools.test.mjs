import assert from "node:assert/strict";
import test from "node:test";
import {
  alignDnaGlobal,
  assembleByExactOverlap,
  formatPairwiseAlignment,
  parseAssemblyFragments,
  planGoldenGateAssembly,
  planRestrictionCloning,
  restrictionEndsCompatible,
} from "../app/design-tools.ts";

function feature(name, start, end, strand = "+") {
  return {
    name,
    type: "misc_feature",
    range: `${start}-${end}`,
    color: "#17b6c9",
    directionality: strand === "+" ? 1 : 2,
    strand,
    segments: [{ range: `${start}-${end}`, start, end, color: "#17b6c9", name: null, type: "standard" }],
    qualifiers: [],
    readingFrame: null,
  };
}

function goldenGatePart(name, leftOverhang, core, rightOverhang, features = []) {
  return {
    name,
    sequence: `GGTCTCA${leftOverhang}${core}${rightOverhang}AGAGACC`,
    features,
  };
}

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

test("plans directional restriction cloning and propagates retained features", () => {
  const result = planRestrictionCloning([
    {
      name: "vector",
      sequence: "GAATTCTTTTAAGCTTCCCCCCCC",
      circular: true,
      leftEnzyme: "EcoRI",
      rightEnzyme: "HindIII",
      retain: "outside",
      features: [feature("backbone marker", 17, 24)],
    },
    {
      name: "insert",
      sequence: "GAATTCAAAACCCCAAGCTT",
      leftEnzyme: "EcoRI",
      rightEnzyme: "HindIII",
      features: [feature("insert CDS", 7, 14)],
    },
  ]);

  assert.equal(result.valid, true);
  assert.equal(result.circular, true);
  assert.equal(result.method, "restriction-cloning");
  assert.equal(result.junctions.every(({ compatible }) => compatible), true);
  assert.deepEqual(result.junctions.map(({ leftEnd, rightEnd }) => [leftEnd.overhang, rightEnd.overhang]), [
    ["AATT", "AATT"],
    ["AGCT", "AGCT"],
  ]);
  assert.deepEqual(result.features.map(({ name, range }) => [name, range]), [
    ["backbone marker", "6-13"],
    ["insert CDS", "20-27"],
  ]);
});

test("keeps an incompatible restriction plan visible with an actionable blocking warning", () => {
  const result = planRestrictionCloning([
    {
      name: "vector",
      sequence: "GAATTCTTTTAAGCTTCCCC",
      circular: true,
      leftEnzyme: "EcoRI",
      rightEnzyme: "HindIII",
      retain: "outside",
    },
    {
      name: "insert",
      sequence: "GAATTCAAAAGGATCC",
      leftEnzyme: "EcoRI",
      rightEnzyme: "BamHI",
    },
  ]);

  assert.equal(result.valid, false);
  assert.equal(result.junctions[1].compatible, false);
  assert.match(result.warnings.find(({ code }) => code === "incompatible-ends").message, /Choose enzymes that make the same overhang/);
  assert.equal(restrictionEndsCompatible(result.junctions[0].leftEnd, result.junctions[0].rightEnd), true);
});

test("plans Golden Gate junctions, orients a reversed part, and carries features", () => {
  const first = goldenGatePart("part A", "GGAG", "TTAA", "AATG", [feature("promoter", 12, 15)]);
  const secondForward = goldenGatePart("part B", "AATG", "CCGG", "GGAG", [feature("reporter", 12, 15)]);
  const second = {
    ...secondForward,
    sequence: secondForward.sequence.split("").reverse().map((base) => ({ A: "T", T: "A", C: "G", G: "C" })[base]).join(""),
    features: [feature("reporter", secondForward.sequence.length - 15 + 1, secondForward.sequence.length - 12 + 1, "-")],
  };
  const result = planGoldenGateAssembly([first, second], { enzyme: "BsaI" });

  assert.equal(result.valid, true);
  assert.equal(result.method, "golden-gate");
  assert.equal(result.fragments[1].reverseComplemented, true);
  assert.equal(result.junctions.every(({ compatible }) => compatible), true);
  assert.equal(result.sequence, "GGAGTTAAAATGCCGG");
  assert.deepEqual(result.features.map(({ name, range, strand }) => [name, range, strand]), [
    ["promoter", "5-8", "+"],
    ["reporter", "13-16", "+"],
  ]);
  assert.match(result.warnings.find(({ code }) => code === "auto-oriented").message, /reverse-complemented/);
});

test("blocks Golden Gate parts with internal enzyme sites", () => {
  const result = planGoldenGateAssembly([
    goldenGatePart("part A", "GGAG", "TTGGTCTCAA", "AATG"),
    goldenGatePart("part B", "AATG", "CCGG", "GGAG"),
  ], { enzyme: "BsaI" });

  assert.equal(result.valid, false);
  assert.match(result.warnings.find(({ code }) => code === "internal-site").message, /Remove or domesticate/);
});
