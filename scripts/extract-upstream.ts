// Dumps the upstream TypeScript data tables into one JSON file for the vanilla-JS app.
import { writeFileSync } from "node:fs";
import i18n from "./src/i18n";
import { effects, effectsArray, isMaxLevel } from "./src/resources/effects";
import { EffectKey } from "./src/resources/effectKeys";
import { items, unsellableItemIds, uniqueItemIds } from "./src/resources/items";
import { nightfarers } from "./src/utils/Nightfarers";
import { recommendedEffectsByCharacter } from "./src/utils/RecommendedEffects";
import * as V from "./src/utils/Vessels";

const out: Record<string, unknown> = {};

// Items: id -> { key, name, color, type }
const itemList: Record<string, unknown> = {};
for (const [id, item] of items) {
  itemList[id] = {
    key: item.key,
    name: i18n.t(`items.${item.key}`, { defaultValue: item.key }),
    color: item.color,
    type: item.type,
  };
}
out.items = itemList;
out.uniqueItemIds = uniqueItemIds;
out.unsellableItemIds = [...new Set(unsellableItemIds)];

// Effects: keyed by EffectKey ordinal; save-file id -> key map separately
const effectDefs: Record<string, unknown> = {};
for (const e of effectsArray) {
  effectDefs[e.key] = {
    key: e.key,
    slug: (EffectKey as unknown as Record<number, string>)[e.key],
    name: i18n.t(`effects.${e.key}`, { defaultValue: `Effect ${e.key}` }),
    nightfarer: "nightfarer" in e ? e.nightfarer : undefined,
    stacks: "stacks" in e ? e.stacks : undefined,
    group: "group" in e ? e.group : undefined,
    level: "level" in e ? e.level : undefined,
    startingBonus: "startingBonus" in e ? e.startingBonus : undefined,
    type: "type" in e ? e.type : undefined,
    maxLevel: isMaxLevel(e),
  };
}
out.effects = effectDefs;
const effectIdToKey: Record<string, number> = {};
for (const [id, e] of effects) effectIdToKey[id] = e.key;
out.effectIdToKey = effectIdToKey;

out.nightfarers = Object.entries(nightfarers).map(([id, nf]) => ({
  id: Number(id),
  name: nf.name,
  vessels: nf.vessels,
}));
out.anyoneVessels = V.anyoneVessels;
out.recommendedEffects = Object.fromEntries(
  Object.entries(recommendedEffectsByCharacter).map(([nf, list]) => [
    nf,
    list.map((e) => e.key),
  ])
);
out.colors = { 0: "Any", 1: "Red", 2: "Blue", 3: "Yellow", 4: "Green" };
out.itemTypes = { 0: "Relic", 1: "UniqueRelic", 2: "DeepRelic", 3: "Misc" };
out.source = "github.com/metinc/nightreign-relic-browser v1.0.30 (MIT)";

writeFileSync(process.argv[2] ?? "game-data.json", JSON.stringify(out));
console.log(
  `items=${items.size} effects=${effectsArray.length} effectIds=${effects.size} nightfarers=${Object.keys(nightfarers).length}`
);
