import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createRecoveryStore } = require("../desktop/recovery-store.cjs");

function record(index) {
  return {
    savedAt: `2026-08-${String(index + 1).padStart(2, "0")}T17:30:00.000Z`,
    workspace: { fileName: "demo.dna", history: Array.from({ length: index }, (_, item) => ({ description: `Edit ${item}` })), data: { sequence: `ACGT${index}` } },
  };
}

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

test("rotates ten desktop snapshots and can delete one checkpoint", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-recovery-history-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createRecoveryStore(path.join(directory, "workspace-recovery.json"));
  for (let index = 0; index < 12; index += 1) await store.save(record(index));
  assert.equal((await store.list()).length, 10);
  assert.equal((await store.load()).savedAt, record(11).savedAt);
  await store.clear(record(7).savedAt);
  assert.equal((await store.list()).some(({ savedAt }) => savedAt === record(7).savedAt), false);
});

test("recovers an atomic snapshot after the writer process is killed and the app relaunches", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-crash-relaunch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "workspace-recovery.json");
  const storeModule = path.resolve("desktop/recovery-store.cjs");
  const script = `const { createRecoveryStore } = require(${JSON.stringify(storeModule)}); createRecoveryStore(${JSON.stringify(filePath)}).save(${JSON.stringify(record(4))}).then(() => { process.stdout.write("READY\\n"); setInterval(() => {}, 1000); });`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => chunk.toString().includes("READY") ? resolve() : reject(new Error("Writer did not become ready.")));
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const relaunchedStore = createRecoveryStore(filePath);
  assert.deepEqual(await relaunchedStore.load(), record(4));
  await assert.rejects(access(`${filePath}.tmp`));
});

test("ignores a corrupt recovery file instead of breaking relaunch", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-corrupt-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "workspace-recovery.json");
  await writeFile(filePath, "{incomplete", "utf8");

  assert.equal(await createRecoveryStore(filePath).load(), null);
});
