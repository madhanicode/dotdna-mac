import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createAddgeneService, genbankUrls } = require("../desktop/addgene-service.cjs");

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ""),
};

test("stores the API token encrypted and retrieves a known plasmid through Addgene-only URLs", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotdna-addgene-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credentialPath = path.join(directory, "credentials.json");
  const requests = [];
  const genbankText = "LOCUS       DEMO 20 bp DNA linear UNK 01-JAN-2000\nFEATURES             Location/Qualifiers\nORIGIN\n        1 aaaaccccggggttttaaaa\n//\n";
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (String(url).includes("plasmid-with-sequences")) return new Response(JSON.stringify({ plasmid_name: "Demo", public_addgene_full_sequences: [{ genbank_url: "https://api.developers.addgene.org/download/genbank/77/" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(genbankText, { status: 200 });
  };
  const service = createAddgeneService({ credentialPath, safeStorage, fetchImpl });
  await service.configure("approved-token-12345");
  assert.equal((await readFile(credentialPath, "utf8")).includes("approved-token-12345"), false);
  const result = await service.fetchPlasmid("77");
  assert.equal(result.plasmidName, "Demo");
  assert.match(result.genbankText, /^LOCUS/m);
  assert.equal(requests.length, 2);
  assert.equal(requests.every(({ options }) => options.headers.Authorization === "Token approved-token-12345"), true);
  assert.equal(requests.every(({ url }) => new URL(url).hostname.endsWith("addgene.org")), true);
});

test("rejects untrusted GenBank download hosts returned by a payload", () => {
  assert.deepEqual(genbankUrls({ genbank_url: "https://evil.example/sequence.gb" }), []);
  assert.deepEqual(genbankUrls({ genbank_url: "https://media.addgene.org/sequence.gb" }), ["https://media.addgene.org/sequence.gb"]);
});
