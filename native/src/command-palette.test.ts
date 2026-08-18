import { describe, expect, it, vi } from "vitest";
import { filterPaletteCommands, type PaletteCommand } from "./CommandPalette";

const command = (id: string, label: string, detail: string, keywords: string[] = []): PaletteCommand => ({ id, label, detail, group: "Test", keywords, run: vi.fn() });

describe("command palette filtering", () => {
  const commands = [
    command("save", "Save Document", "Write the current project", ["disk"]),
    command("find", "Find Sequence", "Highlight DNA matches", ["search", "iupac"]),
    command("folder", "Open Project Folder", "Browse sequence files", ["workspace"]),
  ];

  it("matches labels, details, groups, and keywords case-insensitively", () => {
    expect(filterPaletteCommands(commands, "IUPAC").map(({ id }) => id)).toEqual(["find"]);
    expect(filterPaletteCommands(commands, "sequence files").map(({ id }) => id)).toEqual(["folder"]);
    expect(filterPaletteCommands(commands, "test")).toHaveLength(3);
  });

  it("ranks exact and prefix label matches ahead of loose metadata matches", () => {
    expect(filterPaletteCommands([
      command("keyword", "Open Folder", "Save a workspace", ["save document"]),
      command("exact", "Save Document", "Write now"),
      command("prefix", "Save Document As", "Write elsewhere"),
    ], "save document").map(({ id }) => id)).toEqual(["exact", "prefix", "keyword"]);
  });

  it("preserves the curated command order for an empty query", () => {
    expect(filterPaletteCommands(commands, "  ")).toBe(commands);
  });
});
