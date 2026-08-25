import assert from "node:assert/strict";
import test from "node:test";
import { reverseComplement } from "../app/sequence-analysis.ts";
import {
  ADDGENE_ID_QUALIFIER,
  apiResultToCandidate,
  extractAddgeneCatalogRecords,
  findAddgeneCandidates,
  matchSequence,
  parseAddgeneCatalog,
  transferAddgeneAnnotations,
} from "../app/addgene.ts";

const sequence = "AAAACCCCGGGGTTTTAAAACCCC";
const feature = {
  name: "marker",
  type: "misc_feature",
  range: "5-8",
  color: "#17b6c9",
  directionality: 1,
  strand: "+",
  segments: [{ range: "5-8", start: 5, end: 8, color: "#17b6c9", name: null, type: "standard" }],
  qualifiers: [],
  readingFrame: null,
};
const record = { id: "123", name: "Demo plasmid", sequence, features: [feature], sourceUrl: "https://www.addgene.org/123/" };

test("transfers exact annotations across circular rotation with Addgene provenance", () => {
  const target = sequence.slice(4) + sequence.slice(0, 4);
  const transform = matchSequence(target, sequence, true);
  assert.deepEqual(transform, { exact: true, orientation: "forward", offset: 4, rotated: true });
  const transferred = transferAddgeneAnnotations(record, target, true, transform);
  assert.equal(transferred[0].range, "1-4");
  assert.equal(transferred[0].qualifiers.find(({ name }) => name === ADDGENE_ID_QUALIFIER)?.value, "123");
});

test("flips coordinates and strand for an exact reverse-complement match", () => {
  const target = reverseComplement(sequence);
  const transform = matchSequence(target, sequence, false);
  assert.equal(transform?.orientation, "reverse");
  const transferred = transferAddgeneAnnotations(record, target, false, transform);
  assert.equal(transferred[0].range, "17-20");
  assert.equal(transferred[0].strand, "-");
  assert.equal(transferred[0].directionality, 2);
});

test("keeps near catalog matches review-only", () => {
  const near = { ...record, sequence: `${sequence.slice(0, -1)}A` };
  const candidates = findAddgeneCandidates([near], sequence, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].transform, null);
  assert.deepEqual(candidates[0].annotations, []);
});

test("extracts nested licensed catalog records and rejects non-JSON input", () => {
  const payload = { addgene_id: "123", plasmid_name: "Demo plasmid", sequences: [{ sequence, features: [feature] }] };
  assert.equal(extractAddgeneCatalogRecords(payload)[0].id, "123");
  assert.equal(parseAddgeneCatalog(JSON.stringify(payload))[0].features.length, 1);
  assert.throws(() => parseAddgeneCatalog("not json"), /valid Addgene JSON/i);
});

test("parses official GenBank results and applies only on full-sequence identity", () => {
  const genbankText = `LOCUS       DEMO                      24 bp    DNA     linear   UNK 01-JAN-2000\nFEATURES             Location/Qualifiers\n     misc_feature    5..8\n                     /label="marker"\nORIGIN\n        1 aaaaccccgg ggttttaaaa cccc\n//\n`;
  const candidate = apiResultToCandidate({ plasmidId: "123", plasmidName: "Demo", sourceUrl: "https://www.addgene.org/123/", genbankText }, sequence, false);
  assert.equal(candidate.transform?.exact, true);
  assert.equal(candidate.annotations.length, 1);
});
