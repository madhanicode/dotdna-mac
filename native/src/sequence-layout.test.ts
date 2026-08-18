import { describe, expect, it } from "vitest";
import { complementSequence, sequenceRow, visibleRowRange } from "./sequence-layout";

describe("sequence layout", () => {
  it("preserves IUPAC complements for the aligned lower strand", () => {
    expect(complementSequence("ACGTRYSWKMBDHVN")).toBe("TGCAYRSWMKVHDBN");
  });

  it("uses zero-based internal and one-based display-ready row boundaries", () => {
    expect(sequenceRow("ACGTAC", 1, 4)).toEqual({
      index: 1,
      start: 4,
      end: 6,
      forward: "AC",
      complement: "TG",
    });
  });

  it("renders only the rows around the viewport", () => {
    expect(visibleRowRange(420, 420, 100, 42, 2)).toEqual({ first: 8, last: 22 });
  });
});
