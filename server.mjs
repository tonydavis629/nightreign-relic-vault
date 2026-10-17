#!/usr/bin/env node
// Nightreign Relic Vault — local server.
//
// Serves the web app and, read-only, the bytes of your Nightreign save so the page can
// auto-load it and refresh when the game saves. Safety properties (see README):
//   * listens on 127.0.0.1 only and rejects requests whose Host isn't localhost (DNS rebinding)
//   * never writes, renames, locks or deletes anything: this file imports no write APIs.
//     Reads use fs.readFile (shared read on Windows) and change detection uses stat polling,
//     so the game can always write its save normally
//   * never touches the game process or its memory; no network access beyond this socket
//
//   node server.mjs [--port 5177] [--save "C:\path\NR0000.sl2"] [--no-open]
//
// Modded alt saves (*.co2, e.g. More Map Variations via ME3) are the same format and are listed too.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(flag("--port") ?? process.env.PORT ?? 5177);
const HOST = "127.0.0.1";
const EXTRA_SAVE = flag("--save") ?? process.env.NIGHTREIGN_SAVE;
const OPEN_BROWSER = !args.includes("--no-open");
const POLL_MS = 2000;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Save discovery
// ---------------------------------------------------------------------------

function saveRoot() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Nightreign");
}

/**
 * Returns [{ id, label, path, size, mtimeMs }] for every NR0000.sl2 found, plus the .co2 alt saves
 * that mod loaders (ME3 profiles such as More Map Variations) keep next to it, plus --save.
 */
async function discoverSaves() {
  const found = [];
  const add = async (id, label, path) => {
    try {
      const s = await stat(path);
      if (s.isFile()) found.push({ id, label, path, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // no such save
    }
  };
  try {
    for (const dirent of await readdir(saveRoot(), { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const dir = join(saveRoot(), dirent.name);
      await add(dirent.name, "Normal game (NR0000.sl2)", join(dir, "NR0000.sl2"));
      for (const name of await readdir(dir).catch(() => [])) {
        if (extname(name).toLowerCase() === ".co2") await add(`${dirent.name}~${name}`, `Modded (${name})`, join(dir, name));
      }
    }
  } catch {
    // Nightreign folder missing (game not installed for this user)
  }
  if (EXTRA_SAVE) {
    try {
      const s = await stat(EXTRA_SAVE);
      found.unshift({ id: "custom", label: basename(EXTRA_SAVE), path: resolve(EXTRA_SAVE), size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      console.warn(`--save ${EXTRA_SAVE} not found; ignoring`);
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Reads the whole save in one go. If the game wrote to it while we were reading
 * (mtime/size changed), read again so the page never gets a torn file.
 */
async function readSaveConsistently(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await stat(path);
    const bytes = await readFile(path); // flag "r": read-only, shared
    const after = await stat(path);
    if (before.mtimeMs === after.mtimeMs && before.size === after.size && bytes.length === after.size) {
      return { bytes, mtimeMs: after.mtimeMs };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Save kept changing while reading; try again in a moment");
}

// ---------------------------------------------------------------------------
// Live updates (Server-Sent Events) via stat polling
// ---------------------------------------------------------------------------

const clients = new Set();
const watched = new Map(); // path -> id

async function refreshWatches() {
  const saves = await discoverSaves();
  for (const s of saves) {
    if (watched.has(s.path)) continue;
    watched.set(s.path, s.id);
    // watchFile polls with stat(); it holds no open handle on the save.
    watchFile(s.path, { interval: POLL_MS, persistent: false }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      const msg = `event: save-changed\ndata: ${JSON.stringify({ id: s.id, mtimeMs: cur.mtimeMs })}\n\n`;
      for (const res of clients) res.write(msg);
    });
  }
  return saves;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });

function hostAllowed(req) {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^([/\\])+/, "");
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, "Forbidden");
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Content-Length": s.size, "Cache-Control": "no-cache" });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, "Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 421, "This server only answers to localhost");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Read-only server", { Allow: "GET, HEAD" });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/saves") {
      const saves = await refreshWatches();
      return json(res, 200, { root: saveRoot(), saves: saves.map(({ id, label, path, size, mtimeMs }) => ({ id, label, path, size, mtimeMs })) });
    }

    const m = url.pathname.match(/^\/api\/saves\/([^/]+)\/file$/);
    if (m) {
      // Only ids we discovered ourselves are served — no client-supplied paths.
      const save = (await discoverSaves()).find((s) => s.id === decodeURIComponent(m[1]));
      if (!save) return json(res, 404, { error: "Unknown save" });
      const { bytes, mtimeMs } = await readSaveConsistently(save.path);
      return send(res, 200, bytes, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Save-Mtime": String(mtimeMs) });
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is in use — is Relic Vault already running? Open http://localhost:${PORT} or pass --port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const url = `http://localhost:${PORT}`;
  const saves = await refreshWatches();
  console.log(`Relic Vault running at ${url}  (Ctrl+C to stop)`);
  console.log(saves.length ? `Found ${saves.length} save(s): ${saves.map((s) => s.path).join(", ")}` : `No save found under ${saveRoot()} — you can still open a .sl2 file from the page.`);
  console.log("Read-only: this server never writes to your save or touches the game.");
  if (OPEN_BROWSER) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const p of watched.keys()) unwatchFile(p);
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
