import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..", "..");
const standaloneRoot = path.join(projectRoot, ".next", "standalone");
const nextNodeModules = path.join(standaloneRoot, "node_modules");
const packagedNodeModules = path.join(standaloneRoot, "server_modules");

async function removeDanglingSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        await access(entryPath);
      } catch {
        await rm(entryPath, { force: true });
      }
    } else if (entry.isDirectory()) {
      await removeDanglingSymlinks(entryPath);
    }
  }
}

await access(path.join(standaloneRoot, "server.js"));
await rename(nextNodeModules, packagedNodeModules);
const pnpmStore = path.join(packagedNodeModules, ".pnpm");
for (const packageDirectory of await readdir(pnpmStore)) {
  if (packageDirectory.startsWith("sharp@") || packageDirectory.startsWith("@img+sharp") || packageDirectory.startsWith("esbuild@") || packageDirectory.startsWith("@esbuild+")) {
    await rm(path.join(pnpmStore, packageDirectory), { recursive: true, force: true });
  }
  if (packageDirectory.startsWith("next@")) {
    await rm(path.join(pnpmStore, packageDirectory, "node_modules", "sharp"), { force: true });
  }
}
await removeDanglingSymlinks(packagedNodeModules);
await mkdir(path.join(standaloneRoot, ".next"), { recursive: true });
await cp(path.join(projectRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"), { recursive: true, force: true });
await cp(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"), { recursive: true, force: true });

console.log(`Prepared standalone DOTDNA bundle at ${standaloneRoot}`);
