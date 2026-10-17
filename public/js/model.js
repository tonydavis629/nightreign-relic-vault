// Turns raw parsed slots into display-ready relics: names, colors, in-game grid
// coordinates, and duplicate/outclassed ("sell") detection. Ported from upstream
// RelicParser.setCoordinates + RelicProcessor (MIT).

import { ItemType, RELIC_COLORS } from "./game-data.js";

const PER_ROW = 8;

export function buildCharacter(rawSlot, gd) {
  const relics = rawSlot.relics.map((r, i) => {
    const item = gd.item(r.itemId);
    // The game reassigns inventory handles every session; the acquisition counter plus
    // the relic's contents is what stays stable across saves.
    const key = `${r.sortKey}:${r.itemId}:${r.effects.map((p) => p.join("/")).join(",")}`;
    return {
      key,
      uid: `${rawSlot.index}:${key}`,
      index: i,
      handle: r.handle,
      itemId: r.itemId,
      item,
      name: item.name,
      color: item.color ?? 1,
      isDeep: item.type === ItemType.DeepRelic,
      isUnique: gd.uniqueItemIds.has(r.itemId),
      sellable: !gd.unsellableItemIds.has(r.itemId),
      sortKey: r.sortKey,
      effects: r.effects.map(([e, c]) => (c === undefined ? [gd.effectFromId(e)] : [gd.effectFromId(e), gd.effectFromId(c)])),
      coordinates: [0, 0],
      coordinatesByColor: [0, 0],
      redundant: undefined,
    };
  });
  setCoordinates(relics);
  findOutclassedRelics(relics);
  for (const r of relics) {
    r.searchText = [r.name, ...r.effects.flat().map((e) => e.name)].join("\n").toLowerCase();
  }
  return { index: rawSlot.index, name: rawSlot.name, relics, warning: rawSlot.warning };
}

/** Row/column as shown in-game under "Order Found", overall and within the relic's color filter. */
export function setCoordinates(relics) {
  for (const deep of [false, true]) {
    const group = relics.filter((r) => r.isDeep === deep);
    const seenByColor = new Map();
    group.forEach((r, i) => {
      const n = seenByColor.get(r.color) ?? 0;
      seenByColor.set(r.color, n + 1);
      r.coordinates = [Math.floor(i / PER_ROW), i % PER_ROW];
      r.coordinatesByColor = [Math.floor(n / PER_ROW), n % PER_ROW];
    });
  }
}

const groupOf = (e) => (e.group !== undefined && e.level !== undefined ? { group: e.group, level: e.level } : undefined);

/** First relic of the same color/kind whose effects cover all of `relic`'s effects at equal or higher level. */
export function findBetterRelic(relic, sameColor) {
  const effects = relic.effects.map(([e]) => e);
  const better = sameColor.find((other) => {
    if (other === relic || other.effects.length < effects.length) return false;
    const otherEffects = other.effects.map(([e]) => e);
    return effects.every((effect) => {
      const g = groupOf(effect);
      if (!g) return otherEffects.includes(effect);
      const og = otherEffects.map(groupOf).find((x) => x && x.group === g.group);
      return og !== undefined && og.level >= g.level;
    });
  });
  if (!better) return undefined;

  let outclassed = better.effects.length > effects.length;
  if (!outclassed) {
    for (const effect of effects) {
      const g = groupOf(effect);
      if (!g) continue;
      const og = better.effects.map(([e]) => groupOf(e)).find((x) => x && x.group === g.group);
      if (og && og.level > g.level) {
        outclassed = true;
        break;
      }
    }
  }
  return { relic: better, outclassed };
}

export function findOutclassedRelics(relics) {
  for (const deep of [false, true]) {
    const group = relics.filter((r) => r.isDeep === deep);
    const byColor = new Map(RELIC_COLORS.map((c) => [c, group.filter((r) => r.color === c)]));
    for (const relic of group) {
      const redundant = findBetterRelic(relic, byColor.get(relic.color) ?? []);
      if (redundant) relic.redundant = redundant;
    }
  }
}

/** Unique effects (including curses) present on a character, sorted by name. */
export function availableEffects(character) {
  const seen = new Set();
  const out = [];
  for (const r of character.relics) {
    for (const e of r.effects.flat()) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

