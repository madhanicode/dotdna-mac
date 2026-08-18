import { describe, expect, it } from "vitest";
import { findRestrictionSites, scanRestrictionSites } from "./restriction-sites";

describe("findRestrictionSites", () => {
  it("reports actual recognition positions instead of display fixtures", () => {
    const sites = findRestrictionSites("AAAAGAATTCTTTGGATCC", false);
    expect(sites.map(({ enzyme, position, topCutPosition, bottomCutPosition }) => ({ enzyme, position, topCutPosition, bottomCutPosition }))).toEqual([
      { enzyme: "EcoRI", position: 4, topCutPosition: 5, bottomCutPosition: 9 },
      { enzyme: "BamHI", position: 13, topCutPosition: 14, bottomCutPosition: 18 },
    ]);
  });

  it("detects a site that crosses a circular origin", () => {
    const site = findRestrictionSites("ATCCAAAAGG", true).find(({ enzyme }) => enzyme === "BamHI");
    expect(site).toMatchObject({ enzyme: "BamHI", position: 8, recognitionSequence: "GGATCC", wrapsOrigin: true });
    expect(site?.intervals).toEqual([{ start: 8, end: 10 }, { start: 0, end: 4 }]);
    expect(site).toMatchObject({ topCutPosition: 9, bottomCutPosition: 3 });
    expect(findRestrictionSites("ATCCAAAAGG", false)).toHaveLength(0);
  });

  it("preserves reverse Type IIS orientation and directional cuts", () => {
    const site = findRestrictionSites("AAAAGAGACCAAAA", false).find(({ enzyme }) => enzyme === "BsaI");
    expect(site).toMatchObject({ orientation: "reverse", matchedSequence: "GAGACC", topCutPosition: null, bottomCutPosition: 3 });
  });

  it("bounds repetitive-site materialization per enzyme and discloses truncation", () => {
    const scan = scanRestrictionSites("GAATTC".repeat(20), false, 3);
    expect(scan.truncated).toBe(true);
    expect(scan.sites.filter(({ enzyme }) => enzyme === "EcoRI")).toHaveLength(3);
  });
});
