export type SnapGeneSegment = {
  range: string;
  start: number | null;
  end: number | null;
  color: string | null;
  name: string | null;
  type: string | null;
};

export type SnapGeneQualifier = {
  name: string;
  value: string;
};

export type SnapGeneFeature = {
  name: string;
  type: string;
  range: string | null;
  color: string | null;
  directionality: 0 | 1 | 2 | 3;
  strand: "+" | "-" | "both" | null;
  segments: SnapGeneSegment[];
  qualifiers: SnapGeneQualifier[];
  readingFrame: number | null;
};

export type SnapGenePrimerBindingSite = {
  range: string;
  start: number | null;
  end: number | null;
  boundStrand: "+" | "-";
};

export type SnapGenePrimer = {
  name: string;
  sequence: string;
  /** Length of the explicitly validated 3′ template-binding region. */
  bindingLength?: number;
  description: string | null;
  color: string | null;
  phosphorylated: boolean;
  bindingSites: SnapGenePrimerBindingSite[];
};

export type SnapGeneNotes = {
  uuid: string | null;
  type: string | null;
  created: string | null;
  createdUtc: string | null;
  lastModified: string | null;
  lastModifiedUtc: string | null;
  createdBy: string | null;
  accessionNumber: string | null;
  description: string | null;
  comments: string | null;
  sequenceClass: string | null;
  transformedInto: string | null;
};

export type SnapGeneSequenceProperties = {
  upstreamStickiness: number | null;
  downstreamStickiness: number | null;
  upstreamModification: string | null;
  downstreamModification: string | null;
};

export type SnapGenePacket = {
  index: number;
  type: number;
  hexType: string;
  name: string;
  byteLength: number;
  format: "sequence" | "xml" | "binary" | "cookie";
  decoded: boolean;
};

export type SnapGeneHeader = {
  sequenceType: number | null;
  exportVersion: number | null;
  importVersion: number | null;
};

export type SnapGeneData = {
  sequence: string;
  length: number;
  gcPercent: number;
  unknownBases: number;
  circular: boolean;
  doubleStranded: boolean;
  features: SnapGeneFeature[];
  primers: SnapGenePrimer[];
  primerSettings: Record<string, string>;
  notes: SnapGeneNotes;
  sequenceProperties: SnapGeneSequenceProperties;
  enzymeVisibilities: string[];
  customEnzymeSetCount: number;
  alignableSequenceCount: number;
  header: SnapGeneHeader;
  packets: SnapGenePacket[];
  packetCount: number;
};

const textDecoder = new TextDecoder("utf-8");
const allowedBases = /^[ACGTRYSWKMBDHVNU-]+$/;

const packetNames: Record<number, string> = {
  0x00: "DNA sequence",
  0x01: "Compressed DNA",
  0x02: "Unknown data",
  0x03: "Enzyme data",
  0x05: "Primers",
  0x06: "Notes",
  0x07: "History",
  0x08: "Sequence properties",
  0x09: "SnapGene header",
  0x0a: "Features",
  0x0b: "Sequence history",
  0x0c: "Protein features",
  0x0d: "Display settings",
  0x0e: "Custom enzyme sets",
  0x0f: "History tree",
  0x10: "Additional metadata",
  0x11: "Alignable sequences",
  0x12: "Sequence colors",
  0x13: "Feature visibility",
  0x1c: "Enzyme visibility",
};

const decodedPacketTypes = new Set([0x00, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0e, 0x11, 0x1c]);

function decodeEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(source: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\s)${escapedKey}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeEntities(match[2]) : null;
}

function allAttributes(source: string) {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeEntities(match[3]);
  }
  return result;
}

function elements(xml: string, tag: string) {
  const expression = new RegExp(`<${tag}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${tag}>)`, "gi");
  return [...xml.matchAll(expression)].map((match) => ({ attributes: match[1], body: match[2] ?? "" }));
}

function textElement(xml: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTag}\\b([^>]*)>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  if (!match) return { value: null, attributes: "" };
  return { value: cleanText(match[2]), attributes: match[1] };
}

function cleanText(value: string) {
  const decoded = decodeEntities(decodeEntities(value));
  return decoded
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseRange(range: string | null) {
  const match = range?.match(/(\d+)\s*-\s*(\d+)/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : { start: null, end: null };
}

function parseFeatures(xml: string): SnapGeneFeature[] {
  return elements(xml, "Feature").map(({ attributes, body }) => {
    const segments = elements(body, "Segment").map(({ attributes: segmentAttributes }) => {
      const range = attribute(segmentAttributes, "range") ?? "";
      const coordinates = parseRange(range);
      return {
        range,
        ...coordinates,
        color: attribute(segmentAttributes, "color"),
        name: attribute(segmentAttributes, "name"),
        type: attribute(segmentAttributes, "type"),
      };
    });
    const qualifiers = elements(body, "Q").map(({ attributes: qualifierAttributes, body: qualifierBody }) => {
      const valueNode = elements(qualifierBody, "V")[0];
      const valueAttributes = valueNode?.attributes ?? "";
      const value = attribute(valueAttributes, "text")
        ?? attribute(valueAttributes, "int")
        ?? attribute(valueAttributes, "bool")
        ?? cleanText(valueNode?.body ?? "");
      return { name: attribute(qualifierAttributes, "name") ?? "qualifier", value: cleanText(value) };
    });
    const directionalityValue = Number(attribute(attributes, "directionality") ?? 0);
    const directionality = ([0, 1, 2, 3].includes(directionalityValue) ? directionalityValue : 0) as 0 | 1 | 2 | 3;

    return {
      name: attribute(attributes, "name") ?? "Unnamed feature",
      type: attribute(attributes, "type") ?? "feature",
      range: segments.map(({ range }) => range).filter(Boolean).join(", ") || null,
      color: segments.find(({ color }) => color)?.color ?? null,
      directionality,
      strand: directionality === 1 ? "+" : directionality === 2 ? "-" : directionality === 3 ? "both" : null,
      segments,
      qualifiers,
      readingFrame: attribute(attributes, "readingFrame") === null ? null : Number(attribute(attributes, "readingFrame")),
    };
  });
}

function parsePrimers(xml: string) {
  const rootAttributes = xml.match(/<Primers\b([^>]*)>/i)?.[1] ?? "";
  const hybridizationAttributes = elements(xml, "HybridizationParams")[0]?.attributes ?? "";
  const primerSettings = { ...allAttributes(rootAttributes), ...allAttributes(hybridizationAttributes) };
  const primers = elements(xml, "Primer").map(({ attributes, body }): SnapGenePrimer => {
    const sequence = (attribute(attributes, "sequence") ?? "").toUpperCase();
    const bindingSites = elements(body, "BindingSite").map(({ attributes: siteAttributes }) => {
      const range = attribute(siteAttributes, "location") ?? attribute(siteAttributes, "range") ?? "";
      const coordinates = parseRange(range);
      return {
        range,
        ...coordinates,
        boundStrand: attribute(siteAttributes, "boundStrand") === "1" ? "-" as const : "+" as const,
      };
    });
    return {
      name: attribute(attributes, "name") ?? "Unnamed primer",
      sequence,
      bindingLength: bindingSites
        .map(({ start, end }) => start !== null && end !== null ? Math.abs(end - start) + 1 : 0)
        .filter((length) => length > 0 && length <= sequence.length)
        .sort((left, right) => right - left)[0],
      description: attribute(attributes, "description") ? cleanText(attribute(attributes, "description") ?? "") : null,
      color: attribute(attributes, "color"),
      phosphorylated: ["1", "true"].includes((attribute(attributes, "phosphorylated") ?? attribute(attributes, "fivePrimePhosphorylated") ?? "").toLowerCase()),
      bindingSites,
    };
  });
  return { primers, primerSettings };
}

function emptyNotes(): SnapGeneNotes {
  return {
    uuid: null,
    type: null,
    created: null,
    createdUtc: null,
    lastModified: null,
    lastModifiedUtc: null,
    createdBy: null,
    accessionNumber: null,
    description: null,
    comments: null,
    sequenceClass: null,
    transformedInto: null,
  };
}

function parseNotes(xml: string): SnapGeneNotes {
  const created = textElement(xml, "Created");
  const modified = textElement(xml, "LastModified");
  return {
    uuid: textElement(xml, "UUID").value,
    type: textElement(xml, "Type").value,
    created: created.value,
    createdUtc: attribute(created.attributes, "UTC"),
    lastModified: modified.value,
    lastModifiedUtc: attribute(modified.attributes, "UTC"),
    createdBy: textElement(xml, "CreatedBy").value,
    accessionNumber: textElement(xml, "AccessionNumber").value,
    description: textElement(xml, "Description").value,
    comments: textElement(xml, "Comments").value,
    sequenceClass: textElement(xml, "SequenceClass").value,
    transformedInto: textElement(xml, "TransformedInto").value,
  };
}

function parseSequenceProperties(xml: string): SnapGeneSequenceProperties {
  const upstreamStickiness = textElement(xml, "UpstreamStickiness").value;
  const downstreamStickiness = textElement(xml, "DownstreamStickiness").value;
  return {
    upstreamStickiness: upstreamStickiness === null ? null : Number(upstreamStickiness),
    downstreamStickiness: downstreamStickiness === null ? null : Number(downstreamStickiness),
    upstreamModification: textElement(xml, "UpstreamModification").value,
    downstreamModification: textElement(xml, "DownstreamModification").value,
  };
}

function emptySequenceProperties(): SnapGeneSequenceProperties {
  return { upstreamStickiness: null, downstreamStickiness: null, upstreamModification: null, downstreamModification: null };
}

function readPacketLength(view: DataView, offset: number) {
  return view.getUint32(offset + 1, false);
}

function isXmlPacket(packet: Uint8Array) {
  const beginning = textDecoder.decode(packet.subarray(0, Math.min(packet.length, 80))).trimStart();
  return beginning.startsWith("<");
}

export function parseSnapGene(buffer: ArrayBuffer): SnapGeneData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.byteLength < 19) {
    throw new Error("This file is too small to be a SnapGene DNA file.");
  }
  if (bytes[0] !== 0x09) {
    throw new Error("This doesn’t appear to be a SnapGene .dna file (the header packet is missing).");
  }

  let cursor = 0;
  let packetCount = 0;
  let hasSnapGeneHeader = false;
  let sequence = "";
  let dnaFlags = 0;
  let features: SnapGeneFeature[] = [];
  let primers: SnapGenePrimer[] = [];
  let primerSettings: Record<string, string> = {};
  let notes = emptyNotes();
  let sequenceProperties = emptySequenceProperties();
  let enzymeVisibilities: string[] = [];
  let customEnzymeSetCount = 0;
  let alignableSequenceCount = 0;
  let header: SnapGeneHeader = { sequenceType: null, exportVersion: null, importVersion: null };
  const packets: SnapGenePacket[] = [];

  while (cursor + 5 <= bytes.byteLength) {
    const packetType = bytes[cursor];
    const packetLength = readPacketLength(view, cursor);
    const dataStart = cursor + 5;
    const dataEnd = dataStart + packetLength;

    if (dataEnd > bytes.byteLength) {
      throw new Error("The SnapGene file is incomplete or damaged.");
    }

    const packet = bytes.subarray(dataStart, dataEnd);
    const xmlPacket = isXmlPacket(packet);
    packets.push({
      index: packetCount,
      type: packetType,
      hexType: `0x${packetType.toString(16).padStart(2, "0").toUpperCase()}`,
      name: packetNames[packetType] ?? "Unrecognized packet",
      byteLength: packetLength,
      format: packetType === 0x09 ? "cookie" : packetType === 0x00 ? "sequence" : xmlPacket ? "xml" : "binary",
      decoded: decodedPacketTypes.has(packetType),
    });

    if (packetType === 0x09) {
      hasSnapGeneHeader = textDecoder.decode(packet.subarray(0, 8)) === "SnapGene";
      if (packet.byteLength >= 14) {
        const headerView = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        header = {
          sequenceType: headerView.getUint16(8, false),
          exportVersion: headerView.getUint16(10, false),
          importVersion: headerView.getUint16(12, false),
        };
      }
    } else if (packetType === 0x00 && packet.byteLength > 1) {
      if (sequence) throw new Error("This SnapGene file contains more than one DNA sequence packet.");
      dnaFlags = packet[0];
      sequence = textDecoder.decode(packet.subarray(1)).replace(/\s/g, "").toUpperCase();
    } else if (packetType === 0x0a) {
      features = parseFeatures(textDecoder.decode(packet));
    } else if (packetType === 0x05) {
      const parsed = parsePrimers(textDecoder.decode(packet));
      primers = parsed.primers;
      primerSettings = parsed.primerSettings;
    } else if (packetType === 0x06) {
      notes = parseNotes(textDecoder.decode(packet));
    } else if (packetType === 0x08) {
      sequenceProperties = parseSequenceProperties(textDecoder.decode(packet));
    } else if (packetType === 0x0e) {
      const xml = textDecoder.decode(packet);
      customEnzymeSetCount = elements(xml, "EnzymeSet").length + elements(xml, "Set").length;
    } else if (packetType === 0x11) {
      const xml = textDecoder.decode(packet);
      alignableSequenceCount = elements(xml, "AlignableSequence").length + elements(xml, "Sequence").length;
    } else if (packetType === 0x1c) {
      const xml = textDecoder.decode(packet);
      const values = attribute(xml.match(/<EnzymeVisibilities\b([^>]*)/i)?.[1] ?? "", "vals") ?? "";
      enzymeVisibilities = values.split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean);
    }

    cursor = dataEnd;
    packetCount += 1;
  }

  if (cursor !== bytes.byteLength) {
    throw new Error("The SnapGene file has trailing bytes that are not a complete packet.");
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
    primers,
    primerSettings,
    notes,
    sequenceProperties,
    enzymeVisibilities,
    customEnzymeSetCount,
    alignableSequenceCount,
    header,
    packets,
    packetCount,
  };
}

export function normalizeDnaSequence(value: string) {
  return value.replace(/\s/g, "").replace(/\d/g, "").toUpperCase().replace(/U/g, "T");
}

export function calculateSequenceStats(sequence: string) {
  const normalized = normalizeDnaSequence(sequence);
  if (!normalized || !allowedBases.test(normalized)) {
    throw new Error("Use DNA bases and supported IUPAC ambiguity symbols only.");
  }
  const canonicalBases = normalized.match(/[ACGT]/g)?.length ?? 0;
  const gcBases = normalized.match(/[GC]/g)?.length ?? 0;
  return {
    sequence: normalized,
    length: normalized.length,
    gcPercent: canonicalBases ? (gcBases / canonicalBases) * 100 : 0,
    unknownBases: normalized.length - canonicalBases,
  };
}

export function createSequenceData(
  sequence: string,
  options: Partial<Pick<SnapGeneData, "circular" | "doubleStranded" | "features" | "primers" | "notes">> = {},
): SnapGeneData {
  return {
    ...calculateSequenceStats(sequence),
    circular: options.circular ?? false,
    doubleStranded: options.doubleStranded ?? true,
    features: options.features ?? [],
    primers: options.primers ?? [],
    primerSettings: {},
    notes: options.notes ?? emptyNotes(),
    sequenceProperties: emptySequenceProperties(),
    enzymeVisibilities: [],
    customEnzymeSetCount: 0,
    alignableSequenceCount: 0,
    header: { sequenceType: 1, exportVersion: null, importVersion: null },
    packets: [],
    packetCount: 0,
  };
}

export function updateSequenceData(
  data: SnapGeneData,
  sequence: string,
  options: Partial<Pick<SnapGeneData, "circular" | "features" | "primers">> = {},
): SnapGeneData {
  return {
    ...data,
    ...calculateSequenceStats(sequence),
    circular: options.circular ?? data.circular,
    features: options.features ?? data.features,
    primers: options.primers ?? data.primers,
  };
}

export function toFasta(name: string, sequence: string) {
  const safeName = name.replace(/\.dna$/i, "").replace(/[^a-z0-9_.-]+/gi, "_");
  const lines = sequence.match(/.{1,80}/g) ?? [];
  return `>${safeName}\n${lines.join("\n")}\n`;
}
