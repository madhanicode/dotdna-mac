import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePrimer,
  designPrimerPair,
  findPrimerBindings,
  simulateInversePcr,
  simulateOverlapExtensionPcr,
  simulatePcr,
  translateReadingFrame,
} from "../app/molecular-biology.ts";
import { reverseComplement } from "../app/sequence-analysis.ts";

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

test("uses nearest-neighbor Tm for the explicit 3-prime binding region", () => {
  const analysis = analyzePrimer("GGATCCACGTTGCAAGTCGATCGTAC", { bindingLength: 20 });
  assert.equal(analysis.tailSequence, "GGATCC");
  assert.equal(analysis.bindingSequence, "ACGTTGCAAGTCGATCGTAC");
  assert.equal(analysis.gcPercent, 50);
  assert.ok(analysis.meltingTemperature > 55 && analysis.meltingTemperature < 61);
  assert.ok(analysis.enthalpy < -150);
});

test("validates a mismatched primer through its exact 3-prime end and incorporates its tail", () => {
  const template = "GATCACGTTGCAAGTCGATCGTACTTGACCGATGCTAGCTAGGATCCGATCGTACCTAGGCTAACGGTTCAGTACCGTATTCGAGCT";
  const bindingSequence = template.slice(4, 24);
  const mismatchedBinding = `${bindingSequence.slice(0, 6)}A${bindingSequence.slice(7)}`;
  const forwardPrimer = `GGATCC${mismatchedBinding}`;
  const reversePrimer = reverseComplement(template.slice(66, 86));
  const bindings = findPrimerBindings(template, forwardPrimer, false, { bindingLength: 20 });

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].tailSequence, "GGATCC");
  assert.equal(bindings[0].mismatchCount, 1);
  assert.equal(bindings[0].threePrimeMatchLength, 13);

  const invalidThreePrime = `${forwardPrimer.slice(0, -1)}A`;
  assert.equal(findPrimerBindings(template, invalidThreePrime, false, { bindingLength: 20 }).length, 0);

  const product = simulatePcr(template, forwardPrimer, reversePrimer, false, {
    forwardBindingLength: 20,
    reverseBindingLength: 20,
  });
  assert.ok(product);
  assert.equal(product.sequence.startsWith(forwardPrimer), true);
  assert.equal(product.sequence.endsWith(template.slice(66, 86)), true);
  assert.equal(product.features.some(({ type }) => type === "tail"), true);
  assert.equal(product.features.some(({ type }) => type === "mutation"), true);
  assert.match(product.warnings.join(" "), /intentional mismatch/);
});

test("simulates an outward-facing inverse PCR product across a circular origin", () => {
  const template = "GATCACGTTGCAAGTCGATCGTACTTGACCGATGCTAGCTAGGATCCGATCGTACCTAGGCTAACGGTTCAGTACCGTA";
  const forwardPrimer = template.slice(49, 69);
  const reversePrimer = reverseComplement(template.slice(9, 29));
  const product = simulateInversePcr(template, forwardPrimer, reversePrimer, {
    forwardBindingLength: 20,
    reverseBindingLength: 20,
  });

  assert.ok(product);
  assert.equal(product.mode, "inverse");
  assert.equal(product.wrapsOrigin, true);
  assert.equal(product.length, template.length - 20);
  assert.equal(product.sequence, template.slice(49) + template.slice(0, 29));
  assert.match(product.warnings.at(-1), /linear amplicon/);
});

test("creates a deterministic overlap-extension product and junction features", () => {
  const template = "TTGACGATCGTACGCTAGCATCGATGCACTGACCTGATCGTACGATGCTAGCTTACGGTACCTGACTAGCGTACCGATGCAATCGGTCAGTCA";
  const outerForward = template.slice(4, 24);
  const outerReverse = reverseComplement(template.slice(70, 90));
  const originalOverlap = template.slice(30, 54);
  const mutatedOverlap = `${originalOverlap.slice(0, 11)}C${originalOverlap.slice(12)}`;
  const product = simulateOverlapExtensionPcr(
    template,
    outerForward,
    reverseComplement(mutatedOverlap),
    mutatedOverlap,
    outerReverse,
    false,
    {
      forwardBindingLength: 20,
      internalReverseBindingLength: 16,
      internalForwardBindingLength: 16,
      reverseBindingLength: 20,
    },
  );

  assert.ok(product);
  assert.equal(product.mode, "overlap-extension");
  assert.equal(product.overlapLength, 24);
  assert.equal(product.sequence, `${template.slice(4, 41)}C${template.slice(42, 90)}`);
  assert.equal(product.features.some(({ type }) => type === "overlap"), true);
  assert.equal(product.features.filter(({ type }) => type === "mutation").length, 1);
  assert.equal(product.features.find(({ type }) => type === "mutation").strand, "both");
});

test("rejects overlap extension when one primary product is entirely overlap", () => {
  const template = "GATCACGTTGCAAGTCGATCGTACTTGACCGATGCTAGCTAGGATCCGATCGTACCTAGGCTAACGGTTCAGTACCGTATTCGAGCT";
  const forward = template.slice(4, 24);
  const reverse = reverseComplement(template.slice(66, 86));
  const product = simulateOverlapExtensionPcr(
    template,
    forward,
    reverse,
    forward,
    reverse,
    false,
    {
      forwardBindingLength: 20,
      internalReverseBindingLength: 20,
      internalForwardBindingLength: 20,
      reverseBindingLength: 20,
    },
  );

  assert.equal(product, null);
});

test("translates positive and negative reading frames", () => {
  assert.equal(translateReadingFrame("ATGAAATAA", 1), "MK*");
  assert.equal(translateReadingFrame("TTATTTCAT", -1), "MK*");
});

test("designs an exact-binding PCR primer pair around a target", () => {
  const template = "GCGCGATCGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGTACGATCGCGC";
  const result = designPrimerPair(template, 25, 82, { minimumLength: 18, maximumLength: 22, searchWindow: 6 });
  assert.equal(result.purpose, "pcr");
  assert.equal(result.forward.strand, "+");
  assert.equal(result.reverse.strand, "-");
  assert.ok(result.forward.length >= 18);
  assert.ok(result.reverse.length >= 18);
  assert.ok(result.predictedAmpliconLength);
});
