import assert from "node:assert/strict";
import { test } from "node:test";
import { findBetterRelic, findOutclassedRelics } from "../public/js/model.js";
import { fixture, loadCharacters, loadGameData, makeRelic } from "./helpers.mjs";

const gd = loadGameData();
const relic = (itemId, ...effectIds) => makeRelic(gd, itemId, ...effectIds.map((id) => gd.effectFromId(id)));

// Ported from upstream src/utils/RelicProcessor.test.ts
test("finds a better relic (higher level of the same effect group) and marks it outclassed", () => {
  const a = relic(104, 7000201);
  const better = relic(107, 7000202);
  const r = findBetterRelic(a, [a, better]);
  assert.equal(r.relic, better);
  assert.equal(r.outclassed, true);
});

test("an identical relic counts as a duplicate, not outclassed (first match wins)", () => {
  const a = relic(104, 7000201);
  const equal = relic(107, 7000201);
  const better = relic(107, 7000202);
  const r = findBetterRelic(a, [a, equal, better]);
  assert.equal(r.relic, equal);
  assert.equal(r.outclassed, false);
});

test("relics of different colors never make each other redundant", () => {
  const a = relic(104, 7000201);
  const otherColor = relic(1005100, 7000202);
  assert.notEqual(a.color, otherColor.color);
  const relics = [a, otherColor];
  findOutclassedRelics(relics);
  assert.equal(a.redundant, undefined);
});

test("a relic with more effects outclasses one whose effects it fully covers", () => {
  const a = relic(104, 7000201);
  const more = relic(104, 7000201, 7000702);
  assert.equal(findBetterRelic(a, [a, more]).outclassed, true);
  assert.equal(findBetterRelic(more, [a, more]), undefined);
});

test("sell candidates exist in a big real save and always point at a same-color, same-kind relic", async () => {
  const [c] = await loadCharacters(fixture("allen.sl2"), gd);
  const flagged = c.relics.filter((r) => r.redundant);
  assert.equal(flagged.length, 39); // same 39 relics upstream flags (verified by diffing against it)
  for (const r of flagged) {
    assert.equal(r.redundant.relic.color, r.color);
    assert.equal(r.redundant.relic.isDeep, r.isDeep);
    assert.notEqual(r.redundant.relic, r);
  }
});

test("relic identity survives the game reassigning inventory handles between sessions", async () => {
  const { buildCharacter } = await import("../public/js/model.js");
  const raw = (handles) => ({
    index: 0, name: "x",
    relics: [
      { handle: handles[0], itemId: 104, effects: [[7000201]], sortKey: 20 },
      { handle: handles[1], itemId: 107, effects: [[7000202]], sortKey: 19 },
    ],
  });
  const a = buildCharacter(raw([0xc080125c, 0xc0800cb6]), gd);
  const b = buildCharacter(raw([0xc08004af, 0xc0800486]), gd);
  assert.deepEqual(a.relics.map((r) => r.key), b.relics.map((r) => r.key));
  assert.equal(new Set(a.relics.map((r) => r.key)).size, 2);
});
