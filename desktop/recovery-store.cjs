/* eslint-disable @typescript-eslint/no-require-imports */

const defaultFileSystem = require("node:fs/promises");
const path = require("node:path");

const MAX_RECORDS = 10;

function asRecords(value) {
  if (value?.format === "dotdna-recovery-history" && value.version === 1 && Array.isArray(value.records)) {
    return value.records.slice(0, MAX_RECORDS);
  }
  return value == null ? [] : [value];
}

function createRecoveryStore(filePath, fileSystem = defaultFileSystem) {
  const temporaryPath = `${filePath}.tmp`;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.catch(() => undefined).then(operation);
    queue = result;
    return result;
  }

  async function readRecords() {
    try {
      return asRecords(JSON.parse(await fileSystem.readFile(filePath, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeRecords(records) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    const serialized = JSON.stringify({ format: "dotdna-recovery-history", version: 1, records: records.slice(0, MAX_RECORDS) });
    const file = await fileSystem.open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fileSystem.rename(temporaryPath, filePath);
  }

  function load() {
    return enqueue(async () => (await readRecords())[0] ?? null);
  }

  function list() {
    return enqueue(readRecords);
  }

  function save(value) {
    if (!JSON.stringify(value)) return Promise.reject(new Error("Recovery data could not be serialized."));
    return enqueue(async () => {
      const records = await readRecords();
      const latest = records[0];
      const sameCheckpoint = latest
        && latest?.workspace?.fileName === value?.workspace?.fileName
        && latest?.workspace?.history?.length === value?.workspace?.history?.length
        && latest?.workspace?.data?.sequence === value?.workspace?.data?.sequence;
      const previous = sameCheckpoint ? records.slice(1) : records;
      const next = [value, ...previous.filter((record) => record?.savedAt !== value?.savedAt)].slice(0, MAX_RECORDS);
      await writeRecords(next);
    });
  }

  function clear(savedAt) {
    return enqueue(async () => {
      if (!savedAt) {
        await Promise.all([fileSystem.rm(filePath, { force: true }), fileSystem.rm(temporaryPath, { force: true })]);
        return;
      }
      const records = (await readRecords()).filter((record) => record?.savedAt !== savedAt);
      if (records.length) await writeRecords(records);
      else await Promise.all([fileSystem.rm(filePath, { force: true }), fileSystem.rm(temporaryPath, { force: true })]);
    });
  }

  return { load, list, save, clear };
}

module.exports = { createRecoveryStore };
