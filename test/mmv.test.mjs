// Modded (More Map Variations) support: .co2 alt saves are discovered and served like .sl2,
// and effects only the mod has get real names from the data/mmv-names.json overlay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGameData } from "../public/js/game-data.js";
import { parseSave } from "../public/js/save-parser.js";
import { fixture } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = JSON.parse(readFileSync(join(root, "public", "data", "game-data.json"), "utf8"));
const overlay = { effects: { 7036501: "[Scholar] Shockwave lowers enemy damage negation", 7060000: "Attack power increased for each evergaol prisoner defeated" }, items: { 19053: "Night-Hued Glass" } };

test("MMV-only effects resolve to named, selectable effects", () => {
  const gd = createGameData(json, overlay);
  const scholar = gd.effectFromId(7036501);
  assert.equal(scholar.name, "[Scholar] Shockwave lowers enemy damage negation (MMV)");
  assert.equal(scholar.nightfarer, 8);
  assert.equal(scholar.unknown, undefined);
  assert.equal(scholar.stacks, false);
  assert.equal(gd.effectFromId(7060000).nightfarer, undefined);
  assert.equal(gd.effectByKey(scholar.key), scholar);
  assert.equal(gd.item(19053).name, "Night-Hued Glass (MMV)");
  assert.equal(gd.unknownEffects.size, 0);
});

test("the overlay never changes base-game effects or their keys", () => {
  const plain = createGameData(json);
  const modded = createGameData(json, { effects: { ...overlay.effects, 10000: "Should be ignored" } });
  for (const id of Object.keys(json.effectIdToKey)) assert.equal(modded.effectFromId(Number(id)).key, plain.effectFromId(Number(id)).key);
  assert.equal(modded.effectFromId(10000).name, plain.effectFromId(10000).name);
  // Same overlay -> same keys (saved builds reference effects by key)
  assert.equal(createGameData(json, overlay).effectFromId(7060000).key, modded.effectFromId(7060000).key);
});

let dir, server;
const PORT = 5900 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "relicvault-mmv-"));
  const steam = join(dir, "Nightreign", "76561190000000000");
  mkdirSync(steam, { recursive: true });
  copyFileSync(fixture("allen.sl2"), join(steam, "NR0000.sl2"));
  copyFileSync(fixture("10slots.sl2"), join(steam, "NR0000.co2"));
  server = spawn(process.execPath, [join(root, "server.mjs"), "--port", String(PORT), "--no-open"], {
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

test("lists the modded .co2 save next to the normal one and serves it", async () => {
  const { saves } = await (await fetch(`${base}/api/saves`)).json();
  const normal = saves.find((s) => s.id === "76561190000000000");
  const modded = saves.find((s) => s.id === "76561190000000000~NR0000.co2");
  assert.equal(normal?.label, "Normal game (NR0000.sl2)");
  assert.equal(modded?.label, "Modded (NR0000.co2)");
  const bytes = Buffer.from(await (await fetch(`${base}/api/saves/${encodeURIComponent(modded.id)}/file`)).arrayBuffer());
  assert.deepEqual(bytes, readFileSync(fixture("10slots.sl2")));
  const { slots } = await parseSave(bytes);
  assert.ok(slots.some((s) => s.name));
});
