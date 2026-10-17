import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { buildSearch, runSearch } from "../public/js/combo-core.js";
import { Color, EffectType } from "../public/js/game-data.js";
import { comboRequest, effectBySlug, fixture, loadCharacters, loadGameData, makeRelic } from "./helpers.mjs";

const gd = loadGameData();
const SCHOLAR = 8;
const red = { name: "Red x3", slots: [Color.Red, Color.Red, Color.Red, Color.Red, Color.Red, Color.Red] };
let allen;
before(async () => { [allen] = await loadCharacters(fixture("allen.sl2"), gd); });

const combosOf = (built, res) => res.combinations.map((c) => c.idx6.map((ix, s) => (ix < 0 ? null : (s < 3 ? built.relics : built.deepRelics)[ix])));
const cursesIn = (relics) => relics.filter(Boolean).flatMap((r) => r.effects.flat()).filter((e) => e.type === EffectType.Debuff).length;

test("documented stacking: two levels of a non-stacking group both score (upstream counted the second as wasted)", () => {
  const base = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGauge");
  const plus1 = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGaugePlus1");
  assert.equal(base.stacks, false);
  assert.equal(base.group, plus1.group);
  const relics = [makeRelic(gd, 102, base), makeRelic(gd, 102, plus1)];
  const req = { nightfarer: SCHOLAR, selectedEffects: [base, plus1], relics, deepRelics: [], enabledVessels: [red],
    selectedEntries: [base, plus1].map((e) => ({ effectKey: e.key, minStacks: 0, maxStacks: 1 })) };
  const { input } = buildSearch(gd, req);
  const fixed = runSearch(input).combinations[0];
  const upstream = runSearch(input, { upstreamGroupDuplicates: true, upstreamGroupSpace: false }).combinations[0];
  assert.ok(fixed.points > upstream.points + 0.5, `${fixed.points} vs ${upstream.points}`);
});

test("priority weights move a high-priority effect ahead", () => {
  const str = effectBySlug(gd, "strengthPlus1"), dex = effectBySlug(gd, "dexterityPlus1");
  const base = comboRequest(gd, allen, { nightfarer: 0, effectKeys: [str.key, dex.key] });
  const count = (built, res, e) => combosOf(built, res)[0].flat().filter(Boolean).flatMap((r) => r.effects.flat())
    .filter((x) => x.group === e.group && x.level >= e.level).length;
  const weigh = (w) => ({ ...base, selectedEntries: base.selectedEntries.map((s) => ({ ...s, weight: s.effectKey === str.key ? w : 1 })) });
  const hi = buildSearch(gd, weigh(3)); const lo = buildSearch(gd, weigh(0.25));
  assert.ok(count(hi, runSearch(hi.input), str) > count(lo, runSearch(lo.input), str));
});

test("a curse penalty picks cleaner combos without losing the selected effects", () => {
  const pau = effectBySlug(gd, "physicalAttackUp");
  const req = comboRequest(gd, allen, { nightfarer: SCHOLAR, effectKeys: [pau.key], ranges: { [pau.key]: [1, 10] } });
  const none = buildSearch(gd, req), strong = buildSearch(gd, { ...req, cursePenalty: 0.4 });
  const top = (built) => combosOf(built, runSearch(built.input))[0];
  assert.ok(cursesIn(top(strong)) < cursesIn(top(none)), `${cursesIn(top(strong))} vs ${cursesIn(top(none))}`);
});

test("relics carrying an excluded effect are dropped before the search", () => {
  const curse = effectBySlug(gd, "ultimateArtChargingImpaired");
  const pau = effectBySlug(gd, "physicalAttackUp");
  const req = comboRequest(gd, allen, { nightfarer: SCHOLAR, effectKeys: [pau.key, curse.key], ranges: { [curse.key]: [0, 0] } });
  const built = buildSearch(gd, req);
  assert.ok(allen.relics.some((r) => r.effects.flat().includes(curse)), "fixture has relics with this curse");
  assert.ok(![...built.relics, ...built.deepRelics].some((r) => r.effects.flat().includes(curse)));
  assert.ok(runSearch(built.input).combinations.length > 0);
});

test("shipped presets reference real effects and a real Nightfarer", () => {
  const presets = JSON.parse(readFileSync(new URL("../public/data/presets.json", import.meta.url), "utf8"));
  assert.ok(presets.length > 0);
  for (const p of presets) {
    assert.ok(gd.nightfarers[p.nightfarer], p.id);
    for (const e of p.effects) effectBySlug(gd, e.slug);
    assert.ok(["off", "light", "strong"].includes(p.cursePenalty));
  }
});

test("regression: a required effect on a low-scoring relic is not lost to the 200-triple shortlist", () => {
  const str = effectBySlug(gd, "strengthPlus3"), dex = effectBySlug(gd, "dexterityPlus3"), vig = effectBySlug(gd, "vigorPlus3");
  const items = effectBySlug(gd, "itemsConferEffectToAllNearbyAllies");
  // 14 strong red fillers -> 364 filler-only triples, all scoring above any triple with the weak relic
  const fillers = Array.from({ length: 14 }, () => { const r = makeRelic(gd, 102, str, dex, vig); return r; });
  const weak = makeRelic(gd, 102, items);
  const req = {
    nightfarer: SCHOLAR, selectedEffects: [str, dex, vig, items], relics: [...fillers, weak], deepRelics: [], enabledVessels: [red],
    selectedEntries: [str, dex, vig].map((e) => ({ effectKey: e.key, minStacks: 0, maxStacks: 10 })).concat({ effectKey: items.key, minStacks: 1, maxStacks: 1 }),
  };
  const { input, relics } = buildSearch(gd, req);
  assert.equal(runSearch(input, { upstreamShortlist: true }).combinations.length, 0, "upstream misses it");
  const found = runSearch(input).combinations;
  assert.ok(found.length > 0);
  for (const c of found) assert.ok(c.idx6.slice(0, 3).some((ix) => relics[ix] === weak));
});
