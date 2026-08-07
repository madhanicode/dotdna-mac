import assert from "node:assert/strict";
import test from "node:test";
import { parseSnapGene, toFasta } from "../app/snapgene.ts";

function packet(type, payload) {
  const result = new Uint8Array(payload.length + 5);
  result[0] = type;
  new DataView(result.buffer).setUint32(1, payload.length, false);
  result.set(payload, 5);
  return result;
}

function join(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

test("decodes sequence flags, stats, and features", () => {
  const encoder = new TextEncoder();
  const header = packet(0x09, encoder.encode("SnapGene\0\x01\0\x0f\0\x13"));
  const dna = packet(0x00, join(new Uint8Array([0x03]), encoder.encode("ACGTGGCN")));
  const xml = '<Features><Feature name="Demo" type="CDS"><Segment range="2-7" color="#00ff00"/></Feature></Features>';
  const features = packet(0x0a, encoder.encode(xml));
  const bytes = join(header, dna, features);
  const parsed = parseSnapGene(bytes.buffer);

  assert.equal(parsed.sequence, "ACGTGGCN");
  assert.equal(parsed.length, 8);
  assert.equal(parsed.gcPercent, 5 / 7 * 100);
  assert.equal(parsed.unknownBases, 1);
  assert.equal(parsed.circular, true);
  assert.equal(parsed.doubleStranded, true);
  assert.deepEqual(parsed.features[0], { name: "Demo", type: "CDS", range: "2-7", color: "#00ff00" });
});

test("formats FASTA output in 80-base lines", () => {
  const fasta = toFasta("demo file.dna", "A".repeat(81));
  assert.equal(fasta, `>demo_file\n${"A".repeat(80)}\nA\n`);
});
