import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { buildSearch, mergeResults, prepareSearch, runSearch, searchVessels } from "../public/js/combo-core.js";
import { Color } from "../public/js/game-data.js";
import { comboRequest, effectBySlug, fixture, loadCharacters, loadGameData, makeRelic } from "./helpers.mjs";

const gd = loadGameData();
const WYLDER = 0, REVENANT = 5;
const anyone = gd.anyoneVessels;
const wylderVessels = gd.nightfarers[WYLDER].vessels;

/** Equivalent of upstream buildWorkerInput + search_combinations, normal relics only. */
function search(nightfarer, effects, relics, vessels, entries = [], options) {
  const built = buildSearch(gd, { nightfarer, selectedEffects: effects, relics, deepRelics: [], enabledVessels: vessels, selectedEntries: entries });
  const result = runSearch(built.input, options);
  return { ...result, built };
}
const relicsIn = (combo, built) => combo.idx6.slice(0, 3).filter((i) => i >= 0).map((i) => built.relics[i]);

// Ported from upstream src/utils/ComboSearch.test.ts
describe("combo search on 10slots.sl2", () => {
  let relics;
  before(async () => {
    relics = (await loadCharacters(fixture("10slots.sl2"), gd))[0].relics.filter((r) => !r.isDeep);
  });

  test("finds combinations for a single effect", () => {
    const r = search(WYLDER, [gd.effectFromId(7000702)], relics, wylderVessels);
    assert.ok(r.combinations.length > 0);
    assert.ok(r.checked > 0);
  });

  test("finds combinations for multiple effects", () => {
    const r = search(WYLDER, [gd.effectFromId(7000702), gd.effectFromId(8440100)], relics, wylderVessels);
    assert.ok(r.combinations.length > 0);
  });

  test("stacks a stackable effect across relics", () => {
    const dex3 = effectBySlug(gd, "dexterityPlus3");
    const r = search(WYLDER, [dex3], relics, [anyone[2]]);
    const best = r.combinations[0];
    for (const rel of relicsIn(best, r.built)) assert.ok(rel.effects.some(([e]) => e === dex3));
    assert.ok(best.points >= 1 + 0.9 + 0.9 - 1e-6);
  });

  test("a lower-level stackable selection matches higher levels", () => {
    const mind1 = effectBySlug(gd, "mindPlus1"), mind3 = effectBySlug(gd, "mindPlus3");
    const r = search(WYLDER, [mind1], relics, [anyone[2]]);
    const best = r.combinations[0];
    for (const rel of relicsIn(best, r.built)) assert.ok(rel.effects.some(([e]) => e === mind3));
    assert.ok(best.points >= 1 + 0.9 + 0.9 - 1e-6);
  });

  test("does not stack a non-stackable effect", () => {
    const e = effectBySlug(gd, "attackPowerPermanentlyIncreasedForEachEvergaolPrisonerDefeated");
    const r = search(WYLDER, [e], relics, [anyone[2]]);
    const stacks = relicsIn(r.combinations[0], r.built).filter((rel) => rel.effects.some(([x]) => x === e)).length;
    assert.equal(stacks, 1);
  });

  test("exactly 1 combo with just 1 relic", () => {
    const str1 = effectBySlug(gd, "strengthPlus1");
    const r = search(WYLDER, [str1], [makeRelic(gd, 129, str1)], [anyone[2], wylderVessels[1]]);
    assert.equal(r.combinations.length, 1);
  });

  test("combos with 2 relics, exactly 1 with 3", () => {
    const str1 = effectBySlug(gd, "strengthPlus1"), vig1 = effectBySlug(gd, "vigorPlus1");
    assert.ok(search(WYLDER, [str1], [makeRelic(gd, 129, vig1), makeRelic(gd, 129, str1)], [anyone[2]]).combinations.length > 0);
    const three = [makeRelic(gd, 129, vig1), makeRelic(gd, 129, str1), makeRelic(gd, 129, vig1)];
    assert.equal(search(WYLDER, [str1], three, [anyone[2]]).combinations.length, 1);
  });

  test("no points for a starting bonus that another relic overrides", () => {
    const fire = effectBySlug(gd, "startingArmamentDealsFireDamage");
    const holy = effectBySlug(gd, "startingArmamentDealsHolyDamage");
    const vessel = { name: "Test Vessel", slots: [Color.Red, Color.Green, Color.Yellow, Color.Red, Color.Green, Color.Yellow] };
    const r = search(WYLDER, [fire], [makeRelic(gd, 120, fire), makeRelic(gd, 102, holy)], [vessel]);
    assert.equal(r.combinations.length, 1);
    assert.ok(Math.abs(r.combinations[0].points - 0.1) < 1e-6);
  });
});

describe("combo search on allen.sl2", () => {
  let character;
  before(async () => {
    [character] = await loadCharacters(fixture("allen.sl2"), gd);
  });

  for (const slug of ["startingArmamentDealsHolyDamage", "changesCompatibleArmamentsIncantationToWrathOfGoldAtStartOfExpedition"]) {
    test(`finds combos for starting bonus ${slug} with min 1 stack`, () => {
      const e = effectBySlug(gd, slug);
      const relics = character.relics.filter((r) => !r.isDeep);
      const r = search(REVENANT, [e], relics, anyone, [{ effectKey: e.key, minStacks: 1, maxStacks: 1 }]);
      assert.ok(r.combinations.length > 0);
    });
  }

  test("stack ranges are honored (min 2) and max 0 excludes an effect", () => {
    const vig = effectBySlug(gd, "vigorPlus1");
    const req = comboRequest(gd, character, { nightfarer: WYLDER, effectKeys: [vig.key], ranges: { [vig.key]: [2, 10] } });
    const built = buildSearch(gd, req);
    const res = runSearch(built.input);
    assert.ok(res.combinations.length > 0);
    const count = (combo) => combo.idx6.reduce((n, ix, slot) => {
      if (ix < 0) return n;
      const rel = (slot < 3 ? built.relics : built.deepRelics)[ix];
      return n + rel.effects.flat().filter((e) => e.group === vig.group && e.level >= vig.level && e.stacks).length;
    }, 0);
    for (const c of res.combinations) assert.ok(count(c) >= 2);

    const excl = buildSearch(gd, comboRequest(gd, character, { nightfarer: WYLDER, effectKeys: [vig.key], ranges: { [vig.key]: [0, 0] } }));
    for (const c of runSearch(excl.input).combinations) {
      const all = c.idx6.flatMap((ix, slot) => (ix < 0 ? [] : (slot < 3 ? excl.relics : excl.deepRelics)[ix].effects.flat()));
      assert.ok(!all.includes(vig));
    }
  });

  test("splitting vessels across workers gives the same result as one pass", () => {
    const keys = [effectBySlug(gd, "strengthPlus1").key, effectBySlug(gd, "fireAttackPowerUp").key];
    const { input } = buildSearch(gd, comboRequest(gd, character, { nightfarer: WYLDER, effectKeys: keys }));
    const whole = runSearch(input);
    // What the worker pool does: one prepareSearch per worker, one vessel per task, merged in vessel order
    const perVessel = input.enabled_vessels.map((_, v) => searchVessels(prepareSearch(structuredClone(input)), [v])[0]);
    assert.deepEqual(mergeResults(perVessel), whole);
  });

  test("regression: upstream's effect-count limit returned nothing for most Nightfarers", () => {
    const keys = [effectBySlug(gd, "strengthPlus1").key];
    const { input } = buildSearch(gd, comboRequest(gd, character, { nightfarer: WYLDER, effectKeys: keys }));
    assert.ok(input.recommended_effects.length > 35, "Wylder has more than 35 expanded recommended effects");
    assert.equal(runSearch(input, { compat: true }).combinations.length, 0);
    assert.ok(runSearch(input).combinations.length > 0);
  });
});
