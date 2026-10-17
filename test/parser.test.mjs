import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSave, SaveParseError } from "../public/js/save-parser.js";
import { fixture, loadCharacters, loadGameData } from "./helpers.mjs";

// Expected values from upstream's src/test/SaveFile.test.ts
const EXPECTED = {
  "10slots.sl2": [
    ["relicbrowser.com", 1289], ["Frauke", 1], ["Timur", 0], ["Aylin", 0], ["Malte", 0],
    ["Flitzpiepe", 0], ["Arne", 0], ["0000000000000000", 0], ["0123456789abcdef", 0], ["x", 0],
  ],
  "allen.sl2": [["AllenAlchemy", 1839]],
};

for (const [file, slots] of Object.entries(EXPECTED)) {
  test(`${file}: decrypts all 14 entries and reads every character slot`, async () => {
    const parsed = await parseSave(readFileSync(fixture(file)));
    assert.equal(parsed.entryCount, 14);
    assert.deepEqual(parsed.slots.map((s) => [s.name, s.relics.length]), slots);
  });
}

test("relics come out newest first (in-game Order Found)", async () => {
  const { slots } = await parseSave(readFileSync(fixture("allen.sl2")));
  const keys = slots[0].relics.map((r) => r.sortKey);
  assert.deepEqual(keys, [...keys].sort((a, b) => b - a));
});

test("every item and effect id in the fixtures is known to the data tables", async () => {
  const gd = loadGameData();
  for (const file of Object.keys(EXPECTED)) await loadCharacters(fixture(file), gd);
  assert.equal(gd.unknownItems.size, 0, `unknown items: ${[...gd.unknownItems.keys()]}`);
  assert.equal(gd.unknownEffects.size, 0, `unknown effects: ${[...gd.unknownEffects.keys()]}`);
});

test("deep relics carry curses; normal relics never do", async () => {
  const [c] = await loadCharacters(fixture("allen.sl2"));
  const curses = (r) => r.effects.filter((p) => p.length === 2).length;
  assert.ok(c.relics.filter((r) => r.isDeep).some((r) => curses(r) > 0));
  assert.equal(c.relics.filter((r) => !r.isDeep).reduce((n, r) => n + curses(r), 0), 0);
});

test("grid coordinates count normal and deep relics separately, 8 per row", async () => {
  const [c] = await loadCharacters(fixture("allen.sl2"));
  for (const deep of [false, true]) {
    const group = c.relics.filter((r) => r.isDeep === deep);
    group.forEach((r, i) => assert.deepEqual(r.coordinates, [Math.floor(i / 8), i % 8]));
    const firstRed = group.find((r) => r.color === 1);
    assert.deepEqual(firstRed.coordinatesByColor, [0, 0]);
  }
});

test("rejects files that are not Nightreign saves", async () => {
  await assert.rejects(parseSave(new Uint8Array(1000)), SaveParseError);
  await assert.rejects(parseSave(new TextEncoder().encode("BND4 but not really".padEnd(200, "x"))), SaveParseError);
});
