/* eslint-disable @typescript-eslint/no-require-imports */

const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const API_ROOT = "https://api.developers.addgene.org";

function isAddgeneUrl(value) {
  try {
    const url = new URL(value, API_ROOT);
    return url.protocol === "https:" && (url.hostname === "addgene.org" || url.hostname.endsWith(".addgene.org"));
  } catch { return false; }
}

function genbankUrls(value, results = []) {
  if (Array.isArray(value)) value.forEach((item) => genbankUrls(item, results));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /genbank/i.test(key) && isAddgeneUrl(child)) results.push(new URL(child, API_ROOT).href);
      else if (child && typeof child === "object") genbankUrls(child, results);
    }
  }
  return results;
}

function field(value, names) {
  if (!value || typeof value !== "object") return "";
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "";
}

function createAddgeneService({ credentialPath, safeStorage, fetchImpl = globalThis.fetch }) {
  if (!credentialPath) throw new Error("An Addgene credential path is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  async function readToken() {
    let stored;
    try { stored = JSON.parse(await readFile(credentialPath, "utf8")); } catch { return ""; }
    if (!stored || stored.version !== 1 || typeof stored.encryptedToken !== "string") return "";
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this Mac.");
    try { return safeStorage.decryptString(Buffer.from(stored.encryptedToken, "base64")); } catch { return ""; }
  }

  async function configure(tokenValue) {
    const token = String(tokenValue ?? "").trim();
    if (token.length < 12 || token.length > 512 || /\s/.test(token)) throw new Error("Enter a valid Addgene API token.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this Mac.");
    const encryptedToken = safeStorage.encryptString(token).toString("base64");
    await mkdir(path.dirname(credentialPath), { recursive: true });
    const temporaryPath = `${credentialPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, encryptedToken })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, credentialPath);
    return { configured: true, secureStorageAvailable: true };
  }

  async function clear() {
    await rm(credentialPath, { force: true });
  }

  async function status() {
    return { configured: Boolean(await readToken()), secureStorageAvailable: Boolean(safeStorage.isEncryptionAvailable()) };
  }

  async function request(url, token, accept) {
    const response = await fetchImpl(url, { headers: { Accept: accept, Authorization: `Token ${token}` }, redirect: "follow" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Addgene rejected this API token or its catalog-sequence scope.");
      if (response.status === 404) throw new Error("That Addgene plasmid or full sequence was not found.");
      throw new Error(`Addgene API request failed (${response.status}).`);
    }
    return response;
  }

  async function fetchPlasmid(plasmidIdValue) {
    const plasmidId = String(plasmidIdValue ?? "").replace(/^#/, "").trim();
    if (!/^\d{1,12}$/.test(plasmidId)) throw new Error("Enter a numeric Addgene plasmid ID.");
    const token = await readToken();
    if (!token) throw new Error("Connect an approved Addgene API token first.");
    const endpoint = `${API_ROOT}/catalog/plasmid-with-sequences/${encodeURIComponent(plasmidId)}/`;
    const catalogResponse = await request(endpoint, token, "application/json");
    const payload = await catalogResponse.json();
    const urls = [...new Set(genbankUrls(payload))];
    if (!urls.length) throw new Error("Addgene did not return a downloadable full GenBank sequence for this plasmid.");
    let genbankText = "";
    let sourceUrl = urls[0];
    let lastError = null;
    for (const url of urls) {
      try {
        const response = await request(url, token, "text/plain, application/octet-stream");
        const text = await response.text();
        if (/^LOCUS\s/m.test(text) && /^ORIGIN\b/m.test(text)) {
          genbankText = text;
          sourceUrl = url;
          break;
        }
      } catch (error) { lastError = error; }
    }
    if (!genbankText) throw lastError ?? new Error("Addgene’s full sequence download was not a readable GenBank file.");
    return {
      plasmidId,
      plasmidName: field(payload, ["name", "plasmid_name", "plasmidName"]) || `Addgene #${plasmidId}`,
      sourceUrl,
      genbankText,
    };
  }

  return { status, configure, clear, fetchPlasmid };
}

module.exports = { API_ROOT, createAddgeneService, genbankUrls, isAddgeneUrl };
