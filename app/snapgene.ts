export type SnapGeneFeature = {
  name: string;
  type: string;
  range: string | null;
  color: string | null;
};

export type SnapGeneData = {
  sequence: string;
  length: number;
  gcPercent: number;
  unknownBases: number;
  circular: boolean;
  doubleStranded: boolean;
  features: SnapGeneFeature[];
  packetCount: number;
};

const textDecoder = new TextDecoder("utf-8");
const allowedBases = /^[ACGTRYSWKMBDHVNU-]+$/;

function decodeEntities(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(source: string, key: string) {
  const match = source.match(new RegExp(`${key}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : null;
}

function parseFeatures(xml: string): SnapGeneFeature[] {
  const features: SnapGeneFeature[] = [];
  const featurePattern = /<Feature\b([^>]*)>([\s\S]*?)<\/Feature>/g;

  for (const match of xml.matchAll(featurePattern)) {
    const attributes = match[1];
    const body = match[2];
    const segment = body.match(/<Segment\b([^>]*)\/?\s*>/);
    const segmentAttributes = segment?.[1] ?? "";

    features.push({
      name: attribute(attributes, "name") ?? "Unnamed feature",
      type: attribute(attributes, "type") ?? "feature",
      range: attribute(segmentAttributes, "range"),
      color: attribute(segmentAttributes, "color"),
    });
  }

  return features;
}

function readPacketLength(view: DataView, offset: number) {
  return view.getUint32(offset + 1, false);
}

export function parseSnapGene(buffer: ArrayBuffer): SnapGeneData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.byteLength < 19) {
    throw new Error("This file is too small to be a SnapGene DNA file.");
  }

  let cursor = 0;
  let packetCount = 0;
  let hasSnapGeneHeader = false;
  let sequence = "";
  let dnaFlags = 0;
  let features: SnapGeneFeature[] = [];

  while (cursor + 5 <= bytes.byteLength) {
    const packetType = bytes[cursor];
    const packetLength = readPacketLength(view, cursor);
    const dataStart = cursor + 5;
    const dataEnd = dataStart + packetLength;

    if (dataEnd > bytes.byteLength) {
      throw new Error("The SnapGene file is incomplete or damaged.");
    }

    const packet = bytes.subarray(dataStart, dataEnd);

    if (packetType === 0x09) {
      hasSnapGeneHeader = textDecoder.decode(packet).includes("SnapGene");
    } else if (packetType === 0x00 && packet.byteLength > 1 && !sequence) {
      dnaFlags = packet[0];
      sequence = textDecoder
        .decode(packet.subarray(1))
        .replace(/\s/g, "")
        .toUpperCase();
    } else if (packetType === 0x0a) {
      features = parseFeatures(textDecoder.decode(packet));
    }

    cursor = dataEnd;
    packetCount += 1;
  }

  if (!hasSnapGeneHeader) {
    throw new Error("This doesn’t appear to be a SnapGene .dna file.");
  }

  if (!sequence) {
    throw new Error("No DNA sequence was found in this SnapGene file.");
  }

  if (!allowedBases.test(sequence)) {
    throw new Error("The file contains sequence symbols this reader doesn’t support yet.");
  }

  const canonicalBases = sequence.match(/[ACGT]/g)?.length ?? 0;
  const gcBases = sequence.match(/[GC]/g)?.length ?? 0;

  return {
    sequence,
    length: sequence.length,
    gcPercent: canonicalBases ? (gcBases / canonicalBases) * 100 : 0,
    unknownBases: sequence.length - canonicalBases,
    circular: Boolean(dnaFlags & 0x01),
    doubleStranded: Boolean(dnaFlags & 0x02),
    features,
    packetCount,
  };
}

export function toFasta(name: string, sequence: string) {
  const safeName = name.replace(/\.dna$/i, "").replace(/[^a-z0-9_.-]+/gi, "_");
  const lines = sequence.match(/.{1,80}/g) ?? [];
  return `>${safeName}\n${lines.join("\n")}\n`;
}
