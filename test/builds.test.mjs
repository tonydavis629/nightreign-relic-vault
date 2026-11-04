import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fromStored, signature, summary, toStored } from "../public/js/builds.js";
import { buildSearch, runSearch } from "../public/js/combo-core.js";
import { EffectType } from "../public/js/game-data.js";
import { avoidPenaltyForRank, wantedWeight, weightForRank } from "../public/js/priority.js";
import { comboRequest, effectBySlug, fixture, loadCharacters, loadGameData } from "./helpers.mjs";

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
