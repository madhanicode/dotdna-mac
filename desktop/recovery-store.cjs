/* eslint-disable @typescript-eslint/no-require-imports */

const defaultFileSystem = require("node:fs/promises");
const path = require("node:path");

function createRecoveryStore(filePath, fileSystem = defaultFileSystem) {
  const temporaryPath = `${filePath}.tmp`;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.catch(() => undefined).then(operation);
    queue = result;
    return result;
  }

  function load() {
    return enqueue(async () => {
      try {
        const serialized = await fileSystem.readFile(filePath, "utf8");
        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof SyntaxError || error?.code === "ENOENT") return null;
        throw error;
      }
    });
  }

  function save(value) {
    const serialized = JSON.stringify(value);
    if (!serialized) return Promise.reject(new Error("Recovery data could not be serialized."));
    return enqueue(async () => {
      await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
      const file = await fileSystem.open(temporaryPath, "w", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fileSystem.rename(temporaryPath, filePath);
    });
  }

  function clear() {
    return enqueue(async () => {
      await Promise.all([
        fileSystem.rm(filePath, { force: true }),
        fileSystem.rm(temporaryPath, { force: true }),
      ]);
    });
  }

  return { load, save, clear };
}

module.exports = { createRecoveryStore };
