// Proves the "never touches your save" promise: the server serves the save byte-for-byte,
// leaves it unmodified (content + timestamps), contains no file-writing APIs, and the
// browser-side code has no way to write files either.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const PORT = 5300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
let dir, save, server, before_;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "relicvault-test-"));
  save = join(dir, "NR0000.sl2");
  copyFileSync(fixture("10slots.sl2"), save);
  const s = statSync(save);
  before_ = { hash: sha(save), mtimeMs: s.mtimeMs, atime: s.atimeMs, size: s.size };
  // APPDATA points at an empty temp dir so the test never sees a real save
  server = spawn(process.execPath, [join(root, "server.mjs"), "--port", String(PORT), "--save", save, "--no-open"], {
    env: { ...process.env, APPDATA: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("running at") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("serves the save byte-for-byte and leaves it untouched", async () => {
  const { saves } = await (await fetch(`${base}/api/saves`)).json();
  const entry = saves.find((s) => s.id === "custom");
  assert.ok(entry);
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(await (await fetch(`${base}/api/saves/custom/file`)).arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), before_.hash);
  }
  const s = statSync(save);
  assert.equal(sha(save), before_.hash);
  assert.equal(s.mtimeMs, before_.mtimeMs);
  assert.equal(s.size, before_.size);
});

test("only answers to localhost and only to GET/HEAD", async () => {
  const http = await import("node:http");
  const status = (opts) => new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, ...opts }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(await status({ path: "/api/saves", headers: { Host: "evil.example:80" } }), 421);
  assert.equal((await fetch(`${base}/api/saves`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/saves/custom/file`, { method: "PUT", body: "x" })).status, 405);
  assert.equal((await fetch(`${base}/api/saves/..%2f..%2fwindows/file`)).status, 404);
  assert.notEqual((await fetch(`${base}/..%2f..%2fserver.mjs`)).status, 200);
});

test("pushes a live update when the game rewrites the save", async () => {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body.getReader();
  await reader.read(); // ": connected"
  await new Promise((r) => setTimeout(r, 300));
  // Simulate the game saving (this is the test touching its own temp copy)
  const t = new Date(Date.now() + 5000);
  utimesSync(save, t, t);
  let text = "";
  const read = (async () => {
    while (!text.includes("save-changed")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  })();
  await Promise.race([read, new Promise((r) => setTimeout(r, 8000))]);
  await reader.cancel();
  assert.match(text, /event: save-changed/);
});

test("no code path can write files", () => {
  const writeApis = /\b(writeFile|appendFile|createWriteStream|rename|unlink|rmdir|rm\(|truncate|ftruncate|chmod|chown|utimes|copyFile|mkdir|symlink|link\(|open\([^)]*['"][wa+])/;
  const server = readFileSync(join(root, "server.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(server, writeApis);
  for (const f of ["save-parser.js", "model.js", "combo-core.js", "combo-worker.js", "combo-client.js", "game-data.js", "ui.js", "app.js"]) {
    const src = readFileSync(join(root, "public", "js", f), "utf8");
    // Browser code: no File System Access API (showSaveFilePicker / createWritable) and no uploads
    assert.doesNotMatch(src, /showSaveFilePicker|showDirectoryPicker|createWritable|FormData|sendBeacon|XMLHttpRequest/, f);
    assert.doesNotMatch(src, /fetch\(\s*["'`]https?:/, `${f} must not contact external servers`);
  }
});
