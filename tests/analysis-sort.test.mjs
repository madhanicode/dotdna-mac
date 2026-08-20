import assert from "node:assert/strict";
import test from "node:test";
import { sortOrfs, sortRestrictionRows } from "../app/analysis-sort.ts";

const orfs = [
  { id: "short", start: 40, end: 72, strand: "+", frame: 1, aminoAcidLength: 10, nucleotideLength: 33, protein: "MZA", wrapsOrigin: false },
  { id: "long", start: 10, end: 132, strand: "-", frame: -2, aminoAcidLength: 40, nucleotideLength: 123, protein: "MAA", wrapsOrigin: false },
  { id: "medium", start: 20, end: 82, strand: "+", frame: 3, aminoAcidLength: 20, nucleotideLength: 63, protein: "MKA", wrapsOrigin: false },
];

test("sorts ORF rows by every displayed parameter without mutating the source", () => {
  assert.deepEqual(sortOrfs(orfs, "length", "desc").map(({ id }) => id), ["long", "medium", "short"]);
  assert.deepEqual(sortOrfs(orfs, "frame", "asc").map(({ id }) => id), ["long", "short", "medium"]);
  assert.deepEqual(sortOrfs(orfs, "range", "asc").map(({ id }) => id), ["long", "medium", "short"]);
  assert.deepEqual(sortOrfs(orfs, "protein", "asc").map(({ id }) => id), ["long", "medium", "short"]);
  assert.deepEqual(orfs.map(({ id }) => id), ["short", "long", "medium"]);
});

const enzyme = (name, recognition) => ({ name, recognition, kind: "Type II", cutTop: 1, cutBottom: 5 });
const site = (name, recognition, position, index = 0) => ({
  id: `${name}-${index}`,
  enzyme: enzyme(name, recognition),
  position,
  end: position + recognition.length - 1,
  strand: "+",
  wrapsOrigin: false,
});
const restrictionRows = [
  { enzyme: enzyme("ZetaI", "AAAA"), sites: [site("ZetaI", "AAAA", 5)] },
  { enzyme: enzyme("AlphaI", "TTTT"), sites: [site("AlphaI", "TTTT", 30), site("AlphaI", "TTTT", 90, 1)] },
  { enzyme: enzyme("BetaI", "CCCC"), sites: [site("BetaI", "CCCC", 12), site("BetaI", "CCCC", 50, 1), site("BetaI", "CCCC", 80, 2)] },
];

test("sorts restriction-enzyme rows by name, recognition, site count, and first coordinate", () => {
  assert.deepEqual(sortRestrictionRows(restrictionRows, "enzyme", "asc").map(({ enzyme: item }) => item.name), ["AlphaI", "BetaI", "ZetaI"]);
  assert.deepEqual(sortRestrictionRows(restrictionRows, "recognition", "asc").map(({ enzyme: item }) => item.name), ["ZetaI", "BetaI", "AlphaI"]);
  assert.deepEqual(sortRestrictionRows(restrictionRows, "sites", "desc").map(({ enzyme: item }) => item.name), ["BetaI", "AlphaI", "ZetaI"]);
  assert.deepEqual(sortRestrictionRows(restrictionRows, "coordinates", "asc").map(({ enzyme: item }) => item.name), ["ZetaI", "BetaI", "AlphaI"]);
});
