import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { familyName, familyOf, fromStored, signature, summary, toStored } from "../public/js/builds.js";
import { buildSearch, runSearch } from "../public/js/combo-core.js";
import { Color, EffectType } from "../public/js/game-data.js";
import { avoidPenaltyForRank, wantedWeight, weightForRank } from "../public/js/priority.js";
import { comboRequest, effectBySlug, fixture, loadCharacters, loadGameData, makeRelic } from "./helpers.mjs";

const gd = loadGameData();
const SCHOLAR = 8;
let allen;
before(async () => { [allen] = await loadCharacters(fixture("allen.sl2"), gd); });

test("old builds: curses and max-0 effects move to the avoid list; wanted keep their stacks and rank", () => {
  const { build, missing } = fromStored(gd, {
    id: "x", name: "Old", nightfarer: SCHOLAR, cursePenalty: "strong",
    effects: [
      { slug: "physicalAttackUp", min: 1, max: 10, priority: "high" },
      { slug: "itemsConferEffectToAllNearbyAllies", min: 0, max: 1, priority: 3 },
      { slug: "ultimateArtChargingImpaired", min: 0, max: 0, priority: "normal" },
      { slug: "raiderImprovedArcaneReducedVigor", min: 0, max: 0 },
      { slug: "continuousHPLoss", min: 0, max: 1, priority: 4 }, // a curse that was "wanted"
      { slug: "noSuchEffect", min: 1, max: 1 },
    ],
  });
  assert.equal(missing, 1);
  assert.deepEqual(build.wanted.map((e) => [gd.effectByKey(e.effectKey).slug, e.minStacks, e.maxStacks, e.rank]), [
    ["physicalAttackUp", 1, 10, 5],
    ["itemsConferEffectToAllNearbyAllies", 0, 1, 3],
  ]);
  assert.deepEqual(build.avoid.map((a) => [gd.effectByKey(a.effectKey).slug, a.block]), [
    ["ultimateArtChargingImpaired", true],
    ["raiderImprovedArcaneReducedVigor", true],
    ["continuousHPLoss", false],
  ]);
  assert.equal(build.avoid[2].rank, 4);
  assert.ok(build.wanted.every((e) => gd.effectByKey(e.effectKey).type !== EffectType.Debuff));
  assert.equal(summary(build), "1 required · 1 wanted · 3 avoided");
});

test("builds survive a save/load round trip", () => {
  const { build } = fromStored(gd, {
    id: "y", name: "Round", nightfarer: SCHOLAR, excludeDeepEffects: true, cursePenalty: "off",
    effects: [{ slug: "physicalAttackUp", min: 2, max: 4, priority: 1 }],
    avoid: [{ slug: "continuousHPLoss", block: true, priority: 5 }, { slug: "nearDeathReducesMaxHP", priority: 7 }],
  });
  const again = fromStored(gd, JSON.parse(JSON.stringify(toStored(gd, build)))).build;
  assert.deepEqual(again, build);
  assert.equal(signature(again), signature(build));
  assert.equal(again.includeDeep, false);
});

test("required effects score like rank 1; avoid penalties shrink with rank", () => {
  assert.equal(wantedWeight({ minStacks: 1, rank: 12 }), weightForRank(1));
  assert.equal(wantedWeight({ minStacks: 0, rank: 9 }), 1);
  assert.ok(avoidPenaltyForRank(1) > avoidPenaltyForRank(5) && avoidPenaltyForRank(5) > avoidPenaltyForRank(12));
});

test("presets.json builds load with no unknown effects", () => {
  const presets = JSON.parse(readFileSync(new URL("../public/data/presets.json", import.meta.url), "utf8"));
  for (const p of presets) assert.equal(fromStored(gd, p).missing, 0, p.id);
});

test("a soft avoid steers away from an effect without forbidding it", () => {
  const pau = effectBySlug(gd, "physicalAttackUp");
  const req = comboRequest(gd, allen, { nightfarer: SCHOLAR, effectKeys: [pau.key], ranges: { [pau.key]: [1, 10] } });
  const curseCount = (built, curse) => {
    const [top] = runSearch(built.input).combinations;
    return top.idx6.map((ix, s) => (ix < 0 ? null : (s < 3 ? built.relics : built.deepRelics)[ix]))
      .filter(Boolean).flatMap((r) => r.effects.flat()).filter((e) => e === curse).length;
  };
  // Pick the curse the unpenalized best combo carries most
  const plain = buildSearch(gd, req);
  const [top] = runSearch(plain.input).combinations;
  const effects = top.idx6.map((ix, s) => (ix < 0 ? null : (s < 3 ? plain.relics : plain.deepRelics)[ix])).filter(Boolean).flatMap((r) => r.effects.flat());
  const curse = effects.find((e) => e.type === EffectType.Debuff);
  assert.ok(curse, "fixture's best combo carries a curse");
  const avoided = buildSearch(gd, { ...req, avoidEntries: [{ effectKey: curse.key, penalty: avoidPenaltyForRank(1) }] });
  assert.ok(avoided.input.avoid_weights.some(([k]) => k === curse.key));
  assert.ok([...avoided.relics, ...avoided.deepRelics].some((r) => r.effects.flat().includes(curse)), "relics with it are still allowed");
  assert.ok(curseCount(avoided, curse) < curseCount(plain, curse));
});

test("effects that come in strengths form one family with a plain name", () => {
  const pau2 = effectBySlug(gd, "physicalAttackUpPlus2");
  assert.deepEqual(familyOf(gd, pau2).map((e) => e.level), [0, 1, 2, 3, 4]);
  assert.equal(familyName(gd, pau2), "Physical Attack Up");
  assert.equal(familyName(gd, effectBySlug(gd, "arcanePlus3")), "Arcane");
  assert.equal(familyOf(gd, effectBySlug(gd, "itemsConferEffectToAllNearbyAllies")), null);
});

test("stacking families keep one entry; per-strength families keep a priority per strength", () => {
  const { build } = fromStored(gd, {
    id: "z", name: "Strengths", nightfarer: SCHOLAR,
    effects: [
      { slug: "defeatingEnemiesFillsMoreOfTheArtGauge", min: 1, max: 1, priority: "high" },
      { slug: "defeatingEnemiesFillsMoreOfTheArtGaugePlus1", min: 1, max: 1, priority: "high" },
      { slug: "improvedThrowingPotDamage", min: 0, rank: 3 },
      { slug: "improvedThrowingPotDamagePlus1", min: 2, rank: 1 },
    ],
  });
  const rows = build.wanted.map((e) => [gd.effectByKey(e.effectKey).slug, e.minStacks, e.maxStacks, e.rank]);
  assert.deepEqual(rows, [
    // each Art gauge strength is its own bonus, matched exactly
    ["defeatingEnemiesFillsMoreOfTheArtGauge", 1, 1, 5],
    ["defeatingEnemiesFillsMoreOfTheArtGaugePlus1", 1, 1, 5],
    // pot damage stacks: one entry, "+1 or better", the required one wins
    ["improvedThrowingPotDamagePlus1", 2, 10, 1],
  ]);
});

test("a family that doesn't stack matches stronger levels when asked (or_better)", () => {
  const base = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGauge");
  const plus1 = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGaugePlus1");
  assert.equal(base.stacks, false);
  const red = { name: "Red x3", slots: [Color.Red, Color.Red, Color.Red, Color.Red, Color.Red, Color.Red] };
  const req = (orBetter) => ({ nightfarer: SCHOLAR, selectedEffects: [base], relics: [makeRelic(gd, 102, plus1)], deepRelics: [], enabledVessels: [red],
    selectedEntries: [{ effectKey: base.key, minStacks: 1, maxStacks: 10, orBetter }] });
  assert.equal(runSearch(buildSearch(gd, req(false)).input).combinations.length, 0, "exact level only");
  const found = runSearch(buildSearch(gd, req(true)).input).combinations;
  assert.equal(found.length, 1);
  assert.ok(found[0].points > 0.5, "the stronger level scores as wanted (lower levels score a bit less, as upstream)");
});

test("a max of 0 is an exclusion only in old builds; newer builds keep the effect wanted", () => {
  const old = fromStored(gd, { id: "o", nightfarer: SCHOLAR, effects: [{ slug: "physicalAttackUpPlus2", min: 0, max: 0 }] }).build;
  assert.equal(old.wanted.length, 0);
  assert.equal(old.avoid[0].block, true);
  const recent = fromStored(gd, { id: "n", nightfarer: SCHOLAR, effects: [{ slug: "physicalAttackUpPlus2", min: 0, max: 0, priority: 5 }], avoid: [] }).build;
  assert.deepEqual(recent.wanted.map((e) => [e.minStacks, e.maxStacks, e.rank]), [[0, 10, 5]]);
  assert.equal(recent.avoid.length, 0);
});

test("stacking.json corrects the game data's stacking flags", () => {
  const raw = loadGameData({ raw: true });
  for (const [slug, stacks] of [["increasedMaximumHP", false], ["staminaRecoveryUponLandingAttacks", false], ["improvedRoarAndBreathAttacksPlus1", true], ["continuousHpRecovery", true]]) {
    assert.equal(effectBySlug(gd, slug).stacks, stacks, slug);
    assert.equal(effectBySlug(raw, slug).stacks, !stacks, `${slug} (upstream)`);
  }
  assert.equal(effectBySlug(gd, "physicalAttackUp").stacks, true);
});

test("MMV effects: same name as a game effect stacks like it, else name patterns, else not", () => {
  const mmv = loadGameData({ mmv: true }).effectsByKey.filter((e) => e?.mmv);
  const byName = (n) => mmv.find((e) => e.name === `${n} (MMV)`);
  assert.equal(byName("Continuous FP Recovery").stacks, true);
  assert.equal(byName("Madness in Vicinity Improves Attack Power").stacks, false);
  assert.ok(mmv.filter((e) => /in possession at start of expedition/.test(e.name)).every((e) => e.stacks));
});

test("requirements count different strengths of a non-stacking effect, not copies", () => {
  const base = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGauge");
  const plus1 = effectBySlug(gd, "defeatingEnemiesFillsMoreOfTheArtGaugePlus1");
  const red = { name: "Red x3", slots: [Color.Red, Color.Red, Color.Red, Color.Red, Color.Red, Color.Red] };
  const search = (relics, min, options) => runSearch(buildSearch(gd, { nightfarer: SCHOLAR, selectedEffects: [base], relics, deepRelics: [], enabledVessels: [red],
    selectedEntries: [{ effectKey: base.key, minStacks: min, maxStacks: 10, orBetter: true }] }).input, options).combinations;
  const twoCopies = [makeRelic(gd, 102, plus1), makeRelic(gd, 102, plus1)];
  assert.equal(search(twoCopies, 2).length, 0, "two +1 copies are one strength");
  assert.ok(search(twoCopies, 2, { upstreamStackCounting: true, upstreamShortlist: true }).length > 0, "upstream counted copies");
  const both = search([makeRelic(gd, 102, base), makeRelic(gd, 102, plus1)], 2);
  assert.ok(both.length > 0 && both[0].idx6.slice(0, 3).filter((i) => i >= 0).length === 2, "base + +1 are two strengths");
  // A non-stacking effect allowed once is not ruled out by a useless duplicate
  const items = effectBySlug(gd, "itemsConferEffectToAllNearbyAllies");
  const dup = buildSearch(gd, { nightfarer: SCHOLAR, selectedEffects: [items], relics: [makeRelic(gd, 102, items), makeRelic(gd, 102, items)], deepRelics: [], enabledVessels: [red],
    selectedEntries: [{ effectKey: items.key, minStacks: 1, maxStacks: 1 }] });
  assert.ok(runSearch(dup.input).combinations.some((c) => c.idx6.slice(0, 3).filter((i) => i >= 0).length === 2));
});

test("a per-strength family saved as 'this strength or stronger' gets a row per stronger strength", () => {
  const { build } = fromStored(gd, { id: "i", nightfarer: SCHOLAR, avoid: [],
    effects: [{ slug: "attackPowerUpWhenFacingPoisonAfflictedEnemy", min: 0, max: 10, priority: 4 }] });
  assert.deepEqual(build.wanted.map((e) => [gd.effectByKey(e.effectKey).slug, e.minStacks, e.maxStacks, e.rank]), [
    ["attackPowerUpWhenFacingPoisonAfflictedEnemy", 0, 1, 4],
    ["attackPowerUpWhenFacingPoisonAfflictedEnemyPlus1", 0, 1, 4],
    ["attackPowerUpWhenFacingPoisonAfflictedEnemyPlus2", 0, 1, 4],
  ]);
});
