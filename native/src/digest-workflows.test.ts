import { describe, expect, it } from "vitest";
import { defaultDigestEnzyme, digestEndLabel, digestResultIsCurrent, digestSourceLabel, restrictionSiteCounts } from "./digest-workflows";
import type { DigestCommandFragment, DigestCommandResult } from "./types";

const fragment = {
  index: 1,
  sourceSpans: [{ start: 90, end: 100 }, { start: 0, end: 10 }],
  length: 20,
  gcPercent: 50,
  upstreamEnd: { enzymeNames: ["EcoRI"], endType: "five-prime", overhangSequence: "AATT", overhangLength: 4, overhangStrand: "forward", topCutPosition: 90, bottomCutPosition: 94 },
  downstreamEnd: { enzymeNames: [], endType: "natural", overhangSequence: "", overhangLength: 0, overhangStrand: "none", topCutPosition: null, bottomCutPosition: null },
  document: { document: { features: [] } },
} as unknown as DigestCommandFragment;

describe("restriction digest UI workflows", () => {
  it("counts display sites and prefers an available unique cutter", () => {
    const sites = [
      { enzyme: "EcoRI" },
      { enzyme: "BamHI" },
      { enzyme: "BamHI" },
    ] as Parameters<typeof restrictionSiteCounts>[0];
    const counts = restrictionSiteCounts(sites);
    expect(counts).toEqual({ EcoRI: 1, BamHI: 2 });
    expect(defaultDigestEnzyme(counts)).toBe("EcoRI");
    expect(defaultDigestEnzyme(counts, new Set(["EcoRI"]))).toBe("BamHI");
  });

  it("shows origin wrapping and explicit end chemistry", () => {
    expect(digestSourceLabel(fragment)).toContain("crosses origin");
    expect(digestEndLabel(fragment.upstreamEnd)).toBe("EcoRI · 4-nt 5′ AATT · forward strand");
    expect(digestEndLabel(fragment.downstreamEnd)).toBe("Natural template end");
  });

  it("rejects a preview from another document revision", () => {
    const result = { templateId: "doc", templateRevision: 4 } as DigestCommandResult;
    expect(digestResultIsCurrent(result, { id: "doc", revision: 4 })).toBe(true);
    expect(digestResultIsCurrent(result, { id: "doc", revision: 5 })).toBe(false);
  });
});
