import { describe, expect, it } from "vitest";
import { canonicalIntervals, findSequenceMatches, intervalContains, normalizeIntervals, validateFindQuery } from "./sequence-selection";

describe("sequence selection coordinates", () => {
  it("splits a circular range into canonical non-wrapping intervals", () => {
    expect(canonicalIntervals(8, 6, 10, true)).toEqual([{ start: 8, end: 10 }, { start: 0, end: 4 }]);
    expect(intervalContains(canonicalIntervals(8, 6, 10, true), 0)).toBe(true);
    expect(intervalContains(canonicalIntervals(8, 6, 10, true), 5)).toBe(false);
  });

  it("clips linear intervals and rejects empty ranges", () => {
    expect(canonicalIntervals(8, 6, 10, false)).toEqual([{ start: 8, end: 10 }]);
    expect(canonicalIntervals(2, 0, 10, false)).toEqual([]);
  });

  it("preserves biological segment order while validating imported feature intervals", () => {
    expect(normalizeIntervals([{ start: 8, end: 10 }, { start: 0, end: 3 }], 10)).toEqual([{ start: 8, end: 10 }, { start: 0, end: 3 }]);
  });
});

describe("sequence Find", () => {
  it("finds overlapping matches and expands IUPAC query symbols", () => {
    expect(findSequenceMatches("AAAA", "AA", false).map((match) => match.start)).toEqual([0, 1, 2]);
    expect(findSequenceMatches("AGCT", "RS", false).filter(({ strand }) => strand === "forward").map((match) => match.start)).toEqual([0, 1]);
  });

  it("finds a match across a circular origin", () => {
    expect(findSequenceMatches("TTAC", "ACTT", true).filter(({ strand }) => strand === "forward")).toEqual([{
      start: 2,
      intervals: [{ start: 2, end: 4 }, { start: 0, end: 2 }],
      wrapsOrigin: true,
      strand: "forward",
    }]);
  });

  it("finds the reverse complement and reports its strand", () => {
    expect(findSequenceMatches("CAT", "ATG", false)).toEqual([{ start: 0, intervals: [{ start: 0, end: 3 }], wrapsOrigin: false, strand: "reverse" }]);
  });

  it("normalizes uracil and reports invalid query symbols", () => {
    expect(validateFindQuery("a u g")).toEqual({ query: "ATG", error: null });
    expect(validateFindQuery("ACZ").error).toContain("Z");
  });
});
