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

test("decodes sequence flags, stats, multisegment features, and qualifiers", () => {
  const encoder = new TextEncoder();
  const header = packet(0x09, encoder.encode("SnapGene\0\x01\0\x0f\0\x13"));
  const dna = packet(0x00, join(new Uint8Array([0x03]), encoder.encode("ACGTGGCN")));
  const xml = '<Features><Feature name="Demo" type="CDS" directionality="2" readingFrame="-1"><Segment range="2-4" color="#00ff00"/><Segment range="6-7" color="#11aa22"/><Q name="note"><V text="&lt;b&gt;Example&lt;/b&gt; protein"/></Q></Feature></Features>';
  const features = packet(0x0a, encoder.encode(xml));
  const bytes = join(header, dna, features);
  const parsed = parseSnapGene(bytes.buffer);

  assert.equal(parsed.sequence, "ACGTGGCN");
  assert.equal(parsed.length, 8);
  assert.equal(parsed.gcPercent, 5 / 7 * 100);
  assert.equal(parsed.unknownBases, 1);
  assert.equal(parsed.circular, true);
  assert.equal(parsed.doubleStranded, true);
  assert.equal(parsed.features[0].range, "2-4, 6-7");
  assert.equal(parsed.features[0].strand, "-");
  assert.equal(parsed.features[0].segments.length, 2);
  assert.deepEqual(parsed.features[0].qualifiers, [{ name: "note", value: "Example protein" }]);
  assert.equal(parsed.header.exportVersion, 15);
  assert.equal(parsed.packets.length, 3);
  assert.equal(parsed.packets.every(({ decoded }) => decoded), true);
});

test("decodes primers, notes, and end chemistry packets", () => {
  const encoder = new TextEncoder();
  const header = packet(0x09, encoder.encode("SnapGene\0\x01\0\x0f\0\x13"));
  const dna = packet(0x00, join(new Uint8Array([0x02]), encoder.encode("ACGTACGT")));
  const primers = packet(0x05, encoder.encode('<Primers><HybridizationParams minContinuousMatchLen="10"/><Primer name="Fwd" sequence="ACGT" description="demo" color="#123456"><BindingSite location="2-5" boundStrand="0"/></Primer></Primers>'));
  const notes = packet(0x06, encoder.encode('<Notes><UUID>abc-123</UUID><Type>Synthetic</Type><Created UTC="12:30:00">2026.8.7</Created><CreatedBy>DOTDNA</CreatedBy><Description>&lt;p&gt;Example molecule&lt;/p&gt;</Description></Notes>'));
  const properties = packet(0x08, encoder.encode('<AdditionalSequenceProperties><UpstreamStickiness>2</UpstreamStickiness><DownstreamStickiness>-1</DownstreamStickiness><UpstreamModification>Phosphorylated</UpstreamModification><DownstreamModification>Unmodified</DownstreamModification></AdditionalSequenceProperties>'));
  const parsed = parseSnapGene(join(header, dna, primers, notes, properties).buffer);

  assert.equal(parsed.primers[0].name, "Fwd");
  assert.equal(parsed.primers[0].bindingSites[0].start, 2);
  assert.equal(parsed.primerSettings.minContinuousMatchLen, "10");
  assert.equal(parsed.notes.createdBy, "DOTDNA");
  assert.equal(parsed.notes.description, "Example molecule");
  assert.equal(parsed.sequenceProperties.upstreamStickiness, 2);
  assert.equal(parsed.sequenceProperties.upstreamModification, "Phosphorylated");
});

test("formats FASTA output in 80-base lines", () => {
  const fasta = toFasta("demo file.dna", "A".repeat(81));
  assert.equal(fasta, `>demo_file\n${"A".repeat(80)}\nA\n`);
});
