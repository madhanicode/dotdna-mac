import { describe, expect, it } from "vitest";
import { findRestrictionSites } from "./restriction-sites";

describe("findRestrictionSites", () => {
  it("reports actual recognition positions instead of display fixtures", () => {
    expect(findRestrictionSites("AAAAGAATTCTTTGGATCC", false)).toEqual([
      { enzyme: "EcoRI", position: 4, recognitionSequence: "GAATTC" },
      { enzyme: "BamHI", position: 13, recognitionSequence: "GGATCC" },
    ]);
  });

  it("detects a site that crosses a circular origin", () => {
    expect(findRestrictionSites("ATCCAAAAGG", true)).toContainEqual({
      enzyme: "BamHI",
      position: 8,
      recognitionSequence: "GGATCC",
    });
    expect(findRestrictionSites("ATCCAAAAGG", false)).toHaveLength(0);
  });
});
