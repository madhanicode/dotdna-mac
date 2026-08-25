import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packages every local module required by the Electron main process", async () => {
  const manifest = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
  const packagedFiles = new Set(manifest.build.files);

  assert.equal(packagedFiles.has("main.cjs"), true);
  assert.equal(packagedFiles.has("preload.cjs"), true);
  assert.equal(packagedFiles.has("recovery-store.cjs"), true);
  assert.equal(packagedFiles.has("addgene-service.cjs"), true);
  assert.equal(manifest.build.extraResources.some(({ to }) => to === "standalone"), true);
});
