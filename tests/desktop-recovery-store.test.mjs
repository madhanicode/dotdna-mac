import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createRecoveryStore } = require("../desktop/recovery-store.cjs");

test("atomically replaces and clears the desktop recovery file", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state", "workspace-recovery.json");
  const store = createRecoveryStore(filePath);

  assert.equal(await store.load(), null);
  await store.save({ version: 1, sequence: "AAAA" });
  await store.save({ version: 1, sequence: "CCCC", edited: true });

  assert.deepEqual(await store.load(), { version: 1, sequence: "CCCC", edited: true });
  await assert.rejects(access(`${filePath}.tmp`));

  await store.clear();
  assert.equal(await store.load(), null);
});

test("ignores a corrupt recovery file instead of breaking relaunch", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-corrupt-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "workspace-recovery.json");
  await writeFile(filePath, "{incomplete", "utf8");

  assert.equal(await createRecoveryStore(filePath).load(), null);
});
