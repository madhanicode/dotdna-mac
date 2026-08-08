import assert from "node:assert/strict";
import test from "node:test";
import { analyzePrimer, findPrimerBindings, simulatePcr, translateReadingFrame } from "../app/molecular-biology.ts";

test("calculates primer properties and exact bindings", () => {
  const analysis = analyzePrimer("ATGCGT");
  assert.equal(analysis.length, 6);
  assert.equal(analysis.gcPercent, 50);
  assert.equal(analysis.meltingTemperature, 18);
  const bindings = findPrimerBindings("AAAATGCGTAAAA", "ATGCGT");
  assert.deepEqual(bindings.map(({ start, strand }) => [start, strand]), [[4, "+"]]);
});

test("simulates an inward-facing exact-match PCR product", () => {
  const template = "AAAATGCGTACGTTTTCCGGAATTAAAA";
  const product = simulatePcr(template, "ATGCGT", "TTCCGG");
  assert.ok(product);
  assert.equal(product.start, 4);
  assert.equal(product.sequence.startsWith("ATGCGT"), true);
  assert.equal(product.sequence.endsWith("CCGGAA"), true);
});

test("translates positive and negative reading frames", () => {
  assert.equal(translateReadingFrame("ATGAAATAA", 1), "MK*");
  assert.equal(translateReadingFrame("TTATTTCAT", -1), "MK*");
});
