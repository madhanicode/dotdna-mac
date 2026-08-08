import {
  createSequenceData,
  normalizeDnaSequence,
} from "./snapgene.ts";
import type { SnapGeneData, SnapGeneFeature, SnapGeneNotes, SnapGeneSegment } from "./snapgene.ts";

export type ImportedSequence = {
  name: string;
  format: "FASTA" | "GenBank" | "Plain DNA" | "DOTDNA project";
  data: SnapGeneData;
};

type DotDnaProject = {
  format: "dotdna-project";
  version: 1;
  name: string;
  savedAt: string;
  data: SnapGeneData;
};

const featureColors = ["#ff9900", "#17b6c9", "#58c882", "#ff725e", "#8a6be8", "#d9b318", "#e455a7"];

function unquote(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}

function fieldValue(text: string, field: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(field));
  if (start < 0) return null;
  const pieces = [lines[start].slice(12).trim()];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!/^\s{12}\S/.test(lines[index])) break;
    pieces.push(lines[index].trim());
  }
  return pieces.join(" ").trim() || null;
}

function parseLocation(location: string, color: string | null) {
  const segments: SnapGeneSegment[] = [];
  for (const match of location.matchAll(/<?(\d+)(?:\.\.>?(\d+))?/g)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    segments.push({ range: `${start}-${end}`, start, end, color, name: null, type: match[2] ? "standard" : "point" });
  }
  return segments;
}

function parseGenBankFeatures(text: string) {
  const featureBlock = text.match(/^FEATURES[^\n]*\n([\s\S]*?)^ORIGIN\b/m)?.[1] ?? "";
  const records: Array<{ type: string; location: string; qualifierLines: string[] }> = [];
  let current: { type: string; location: string; qualifierLines: string[] } | null = null;

  for (const line of featureBlock.split(/\r?\n/)) {
    const start = line.match(/^\s{5}(\S+)\s+(.+)$/);
    if (start) {
      current = { type: start[1], location: start[2].trim(), qualifierLines: [] };
      records.push(current);
    } else if (current && /^\s{21}\S/.test(line)) {
      const value = line.slice(21).trim();
      if (value.startsWith("/") || !current.qualifierLines.length) current.qualifierLines.push(value);
      else current.qualifierLines[current.qualifierLines.length - 1] += ` ${value}`;
    }
  }

  return records.map((record, index): SnapGeneFeature => {
    const qualifiers = record.qualifierLines
      .filter((line) => line.startsWith("/"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? { name: line.slice(1), value: "true" }
          : { name: line.slice(1, separator), value: unquote(line.slice(separator + 1)) };
      });
    const qualifier = (name: string) => qualifiers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? null;
    const color = qualifier("color") ?? qualifier("ApEinfo_fwdcolor") ?? featureColors[index % featureColors.length];
    const segments = parseLocation(record.location, color);
    const reverse = /complement\s*\(/i.test(record.location);
    return {
      name: qualifier("label") ?? qualifier("gene") ?? qualifier("product") ?? qualifier("note") ?? record.type,
      type: record.type,
      range: segments.map(({ range }) => range).join(", ") || null,
      color,
      directionality: reverse ? 2 : 1,
      strand: reverse ? "-" : "+",
      segments,
      qualifiers,
      readingFrame: qualifier("codon_start") ? Number(qualifier("codon_start")) - 1 : null,
    };
  });
}

function parseGenBank(name: string, text: string): ImportedSequence {
  const locus = text.match(/^LOCUS\s+(\S+).*?\b(circular|linear)\b/im);
  const originTail = text.match(/^ORIGIN\b[^\n]*\n([\s\S]*)/m)?.[1] ?? "";
  const origin = originTail.split(/^\/\/\s*$/m)[0];
  const sequence = normalizeDnaSequence(origin.replace(/[^A-Za-z]/g, ""));
  if (!sequence) throw new Error("No DNA sequence was found in the GenBank ORIGIN section.");
  const features = parseGenBankFeatures(text);
  const data = createSequenceData(sequence, { circular: locus?.[2]?.toLowerCase() === "circular", features });
  data.notes = {
    ...data.notes,
    accessionNumber: fieldValue(text, "ACCESSION"),
    description: fieldValue(text, "DEFINITION"),
    type: /\bSYN\b/i.test(locus?.[0] ?? "") ? "Synthetic" : null,
  };
  return { name: name || `${locus?.[1] ?? "sequence"}.gb`, format: "GenBank", data };
}

function parseFasta(name: string, text: string): ImportedSequence {
  const records = text.trim().split(/(?=^>)/m).filter(Boolean);
  if (!records.length || !records[0].startsWith(">")) throw new Error("This doesn’t contain a FASTA header.");
  const lines = records[0].split(/\r?\n/);
  const title = lines.shift()?.slice(1).trim() || name.replace(/\.[^.]+$/, "") || "sequence";
  const sequence = normalizeDnaSequence(lines.filter((line) => !line.startsWith(";")).join(""));
  if (!sequence) throw new Error("No DNA sequence was found after the FASTA header.");
  const data = createSequenceData(sequence);
  data.notes.description = title;
  return { name: name || `${title.replace(/\s+/g, "_")}.fasta`, format: "FASTA", data };
}

function safeProjectData(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("This DOTDNA project is invalid.");
  const project = value as Partial<DotDnaProject>;
  if (project.format !== "dotdna-project" || project.version !== 1 || !project.data?.sequence) {
    throw new Error("This isn’t a supported DOTDNA project file.");
  }
  const source = project.data;
  const data = createSequenceData(source.sequence, {
    circular: Boolean(source.circular),
    doubleStranded: source.doubleStranded !== false,
    features: Array.isArray(source.features) ? source.features : [],
    primers: Array.isArray(source.primers) ? source.primers : [],
    notes: source.notes as SnapGeneNotes,
  });
  return { name: project.name || "DOTDNA project", data };
}

export function parseTextSequence(name: string, text: string): ImportedSequence {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste or choose a sequence first.");
  if (trimmed.startsWith("{")) {
    const project = safeProjectData(JSON.parse(trimmed));
    return { ...project, format: "DOTDNA project" };
  }
  if (/^LOCUS\s/m.test(trimmed) && /^ORIGIN\b/m.test(trimmed)) return parseGenBank(name, trimmed);
  if (trimmed.startsWith(">")) return parseFasta(name, trimmed);
  const sequence = normalizeDnaSequence(trimmed);
  const data = createSequenceData(sequence);
  return { name: name || "pasted-sequence.dna", format: "Plain DNA", data };
}

function locationForFeature(feature: SnapGeneFeature) {
  const locations = feature.segments.length
    ? feature.segments.map(({ start, end }) => start === end ? String(start) : `${start}..${end}`)
    : feature.range?.split(/,\s*/).map((range) => range.replace("-", "..")) ?? ["1"];
  const compound = locations.length > 1 ? `join(${locations.join(",")})` : locations[0];
  return feature.strand === "-" ? `complement(${compound})` : compound;
}

function quoteQualifier(value: string) {
  return value.replaceAll('"', '""').replace(/[\r\n]+/g, " ");
}

export function toGenBank(name: string, data: SnapGeneData, features: SnapGeneFeature[] = data.features) {
  const safeName = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 16) || "DOTDNA";
  const topology = data.circular ? "circular" : "linear";
  const lines = [
    `LOCUS       ${safeName.padEnd(16)} ${String(data.length).padStart(11)} bp    DNA     ${topology.padEnd(8)} UNK ${new Date().toISOString().slice(0, 10).toUpperCase()}`,
    `DEFINITION  ${data.notes.description ?? "Exported from DOTDNA."}`,
    `ACCESSION   ${data.notes.accessionNumber ?? "."}`,
    "FEATURES             Location/Qualifiers",
    "     source          1.." + data.length,
    "                     /organism=\"synthetic construct\"",
  ];
  for (const feature of features) {
    lines.push(`     ${feature.type.slice(0, 15).padEnd(16)}${locationForFeature(feature)}`);
    lines.push(`                     /label=\"${quoteQualifier(feature.name)}\"`);
    if (feature.color) lines.push(`                     /color=\"${feature.color}\"`);
    for (const qualifier of feature.qualifiers) {
      if (["label", "color"].includes(qualifier.name.toLowerCase())) continue;
      lines.push(`                     /${qualifier.name}=\"${quoteQualifier(qualifier.value)}\"`);
    }
  }
  lines.push("ORIGIN");
  for (let index = 0; index < data.sequence.length; index += 60) {
    const bases = data.sequence.slice(index, index + 60).toLowerCase().match(/.{1,10}/g)?.join(" ") ?? "";
    lines.push(`${String(index + 1).padStart(9)} ${bases}`);
  }
  lines.push("//");
  return `${lines.join("\n")}\n`;
}

export function toDotDnaProject(name: string, data: SnapGeneData, features: SnapGeneFeature[] = data.features) {
  const project: DotDnaProject = {
    format: "dotdna-project",
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    data: { ...data, features },
  };
  return `${JSON.stringify(project, null, 2)}\n`;
}
