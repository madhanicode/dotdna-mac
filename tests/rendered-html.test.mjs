import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the DOTDNA reader", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>DOTDNA — Local DNA Workspace<\/title>/i);
  assert.match(html, /Your DNA sequence/);
  assert.match(html, /Choose file/);
  assert.match(html, /annotate/);
  assert.match(html, /Processed locally/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
