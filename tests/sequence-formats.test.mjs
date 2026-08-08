import assert from "node:assert/strict";
import test from "node:test";
import { parseTextSequence, toDotDnaProject, toGenBank } from "../app/sequence-formats.ts";

test("imports FASTA and plain DNA text", () => {
  const fasta = parseTextSequence("demo.fa", ">demo molecule\nACGT ACGT\n");
  assert.equal(fasta.format, "FASTA");
  assert.equal(fasta.data.sequence, "ACGTACGT");
  assert.equal(fasta.data.notes.description, "demo molecule");

  const plain = parseTextSequence("raw.dna", "acgt nn\nacgt");
  assert.equal(plain.format, "Plain DNA");
  assert.equal(plain.data.sequence, "ACGTNNACGT");
});

test("round-trips sequence, topology, and features through GenBank", () => {
  const source = parseTextSequence("source.fa", ">source\nATGAAATAA").data;
  source.circular = true;
  source.features = [{
    name: "demo CDS", type: "CDS", range: "1-9", color: "#ff9900", directionality: 1, strand: "+",
    segments: [{ range: "1-9", start: 1, end: 9, color: "#ff9900", name: null, type: "standard" }],
    qualifiers: [{ name: "product", value: "demo protein" }], readingFrame: 0,
  }];
  const exported = toGenBank("source.dna", source);
  const imported = parseTextSequence("source.gb", exported);

  assert.equal(imported.data.sequence, source.sequence);
  assert.equal(imported.data.circular, true);
  const cds = imported.data.features.find(({ type }) => type === "CDS");
  assert.equal(cds?.name, "demo CDS");
  assert.equal(cds?.qualifiers.some(({ name, value }) => name === "product" && value === "demo protein"), true);
});

test("round-trips a portable DOTDNA project", () => {
  const source = parseTextSequence("demo.fa", ">demo\nACGTACGT").data;
  const serialized = toDotDnaProject("demo", source);
  const imported = parseTextSequence("demo.dotdna.json", serialized);
  assert.equal(imported.format, "DOTDNA project");
  assert.equal(imported.data.sequence, "ACGTACGT");
});
