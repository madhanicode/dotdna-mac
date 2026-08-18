import { describe, expect, it } from "vitest";
import { bindingSitesFromBinding, buildFeature, buildPrimer, featureRowsFromSegments } from "./annotation-workflows";

describe("feature authoring", () => {
  it("converts one-based circular coordinates into ordered canonical segments", () => {
    const result = buildFeature({ id: "f1", name: "origin", kind: "CDS", color: "#5cc8d7", strand: "forward", rows: [{ start: "9", end: "3", source: [] }], qualifiers: [], readingFrame: "1" }, 10, true);
    expect(result.errors).toEqual([]);
    expect(result.value?.segments.map(({ span }) => span)).toEqual([{ start: 8, end: 10 }, { start: 0, end: 3 }]);
    expect(result.value?.segments.every(({ color }) => color === null)).toBe(true);
    expect(featureRowsFromSegments(result.value!.segments, 10, true)[0]).toMatchObject({ start: "9", end: "3" });
  });

  it("rejects out-of-range and reverse linear coordinates", () => {
    const result = buildFeature({ name: "bad", kind: "gene", color: "#5cc8d7", strand: "forward", rows: [{ start: "8", end: "2", source: [] }, { start: "1", end: "20", source: [] }], qualifiers: [], readingFrame: "" }, 10, false);
    expect(result.value).toBeNull();
    expect(result.errors.join(" ")).toContain("only circular DNA");
    expect(result.errors.join(" ")).toContain("within bases");
  });

  it("preserves hidden segment metadata while changing coordinates", () => {
    const source = { span: { start: 1, end: 4 }, color: "#123456", name: "exon 1", kind: "exon" };
    const result = buildFeature({ name: "joined", kind: "gene", color: "#abcdef", strand: "reverse", rows: [{ start: "3", end: "6", source: [source] }], qualifiers: [{ name: "note", value: "keep" }], readingFrame: "" }, 10, false);
    expect(result.value?.segments[0]).toEqual({ ...source, span: { start: 2, end: 6 } });
    expect(result.value?.qualifiers).toEqual([{ name: "note", value: "keep" }]);
  });
});

describe("primer authoring", () => {
  it("normalizes DNA and preserves an explicit 3-prime binding suffix", () => {
    const result = buildPrimer({ id: "p1", name: " mutagenic ", sequence: "gg atcc ATGC", bindingLength: "4", description: " note ", color: "#79d6e5", phosphorylated: true });
    expect(result.errors).toEqual([]);
    expect(result.value).toMatchObject({ name: "mutagenic", sequence: "GGATCCATGC", binding_length: 4, description: "note", phosphorylated: true });
  });

  it("rejects ambiguous and oversized primers", () => {
    expect(buildPrimer({ name: "bad", sequence: "ACGN", bindingLength: "4", description: "", color: "#79d6e5", phosphorylated: false }).errors.join(" ")).toContain("unsupported");
    expect(buildPrimer({ name: "rna", sequence: "ACGU", bindingLength: "4", description: "", color: "#79d6e5", phosphorylated: false }).errors.join(" ")).toContain("unsupported");
    expect(buildPrimer({ name: "numbered", sequence: "ACG1T", bindingLength: "4", description: "", color: "#79d6e5", phosphorylated: false }).errors.join(" ")).toContain("unsupported");
    expect(buildPrimer({ name: "long", sequence: "A".repeat(501), bindingLength: "20", description: "", color: "#79d6e5", phosphorylated: false }).errors.join(" ")).toContain("500 bases");
    expect(buildPrimer({ name: "too long for template", sequence: "A".repeat(20), bindingLength: "20", description: "", color: "#79d6e5", phosphorylated: false }, 10).errors.join(" ")).toContain("10-base template");
  });

  it("splits a stored circular binding site into canonical spans", () => {
    const sites = bindingSitesFromBinding({ span: { start: 8, end: 2 }, strand: "+", wrapsOrigin: true, bindingLength: 4, tailLength: 0, bindingSequence: "AATT", tailSequence: "", templateSequence: "AATT", mismatchCount: 0, mismatches: [], threePrimeMatchLength: 4, meltingTemperature: 12 }, 10);
    expect(sites).toEqual([{ span: { start: 8, end: 10 }, strand: "forward" }, { span: { start: 0, end: 2 }, strand: "forward" }]);
  });
});
