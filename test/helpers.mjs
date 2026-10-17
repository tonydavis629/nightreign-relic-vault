import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGameData } from "../public/js/game-data.js";
import { parseSave } from "../public/js/save-parser.js";
import { buildCharacter } from "../public/js/model.js";

const root = new URL("..", import.meta.url);
export const fixture = (name) => fileURLToPath(new URL(`test/fixtures/${name}`, root));

export function loadGameData() {
  return createGameData(JSON.parse(readFileSync(new URL("public/data/game-data.json", root), "utf8")));
}

export async function loadCharacters(file, gd = loadGameData()) {
  const parsed = await parseSave(readFileSync(file));
  return parsed.slots.map((s) => buildCharacter(s, gd));
}

/** Mirrors the Combo Finder page: split relics, apply vessel toggles, default stack ranges. */
export function comboRequest(gd, character, { nightfarer, effectKeys, disabledVessels = [], excludeDeep = false, ranges = {} }) {
  const selectedEffects = effectKeys.map((k) => gd.effectByKey(k));
  return {
    nightfarer,
    selectedEffects,
    relics: character.relics.filter((r) => r.item.type === 0 || r.item.type === 1),
    deepRelics: excludeDeep ? [] : character.relics.filter((r) => r.item.type === 2),
    enabledVessels: gd.nightfarers[nightfarer].vessels.filter((_, i) => !disabledVessels.includes(i)),
    selectedEntries: selectedEffects.map((e) => ({
      effectKey: e.key,
      minStacks: ranges[e.key]?.[0] ?? 0,
      maxStacks: ranges[e.key]?.[1] ?? (e.stacks ? 10 : 1),
    })),
  };
}

let nextUid = 0;
/** Minimal relic shaped like model.buildCharacter output. */
export function makeRelic(gd, itemId, ...effects) {
  const item = gd.item(itemId);
  return {
    uid: `t${nextUid++}`, key: `t${nextUid}`, handle: nextUid, item, itemId, name: item.name, color: item.color ?? 1,
    isDeep: item.type === 2, effects: effects.map((e) => [e]), sellable: true,
  };
}

export const effectBySlug = (gd, slug) => {
  const e = gd.effectsByKey.find((x) => x && x.slug === slug);
  if (!e) throw new Error(`No effect ${slug}`);
  return e;
};

export const effectKeyByName = (gd, name) => {
  const e = gd.effectsByKey.find((x) => x && x.name === name);
  if (!e) throw new Error(`No effect named ${name}`);
  return e.key;
};
