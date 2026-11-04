// Builds: a named set of wanted and avoided effects for one Nightfarer. Stored by effect slug
// so they survive data updates. Shape on disk (presets.json and localStorage):
//   { id, name, nightfarer, excludeDeepEffects, cursePenalty,
//     effects: [{ slug, min, max, priority }],          // wanted; min >= 1 means required
//     avoid:   [{ slug, priority, block? }] }           // block = never allowed, else a soft penalty
// Older builds kept curses and exclusions in `effects` (max 0 = excluded); those load into `avoid`.
//
// Effects that come in strengths ("Physical Attack Up", "+1" ... "+4") form a family.
//  - Stacking families (copies add up): wanted once, at a minimum strength, and any stronger level
//    counts too. The stored slug is the level effect for that minimum strength.
//  - Per-strength families (no level stacks with itself, but different strengths add up, e.g.
//    "Defeating enemies fills more of the Art gauge" + "+1"): every strength is its own entry with
//    its own priority, matched exactly.
import { EffectType, isSameGroup } from "./game-data.js";
import { DEFAULT_RANK, clampRank, rankOf } from "./priority.js";

export const CURSE_PENALTIES = ["off", "light", "strong"];

/** Stored build -> working build with effect keys. Unknown slugs are counted in `missing`. */
export function fromStored(gd, stored, bySlug = slugIndex(gd)) {
  const build = {
    id: stored.id,
    name: stored.name || "Untitled build",
    nightfarer: stored.nightfarer,
    includeDeep: !stored.excludeDeepEffects,
    cursePenalty: CURSE_PENALTIES.includes(stored.cursePenalty) ? stored.cursePenalty : "light",
    wanted: [],
    avoid: [],
  };
  let missing = 0;
  const seen = new Set();
  const addAvoid = (effect, e, block) => {
    if (seen.has(effect.key)) return;
    seen.add(effect.key);
    build.avoid.push({ effectKey: effect.key, block, rank: rankOf(e) });
  };
  const legacy = !Array.isArray(stored.avoid); // saved before builds had an avoid list
  for (const e of stored.effects ?? []) {
    const effect = bySlug.get(e.slug);
    if (!effect) { missing++; continue; }
    const max = e.max ?? (effect.stacks ? 10 : 1);
    // Curses are never wanted: an old "selected" curse becomes a soft avoid at the same priority.
    // Max 0 meant "excluded" before builds had an avoid list; in a build that has one, it was only a
    // stack slider dragged to 0, so the effect stays wanted with its maximum reopened.
    const legacyExclude = max === 0 && legacy;
    if (legacyExclude || effect.type === EffectType.Debuff) { addAvoid(effect, e, max === 0); continue; }
    if (seen.has(effect.key)) continue;
    seen.add(effect.key);
    // Old builds stored max 1 for anything that doesn't stack, which now would mean "one strength only"
    const open = max === 0 || (legacy && !effect.stacks);
    build.wanted.push(fitStacks(gd, { effectKey: effect.key, minStacks: e.min ?? 0, maxStacks: open ? 10 : max, rank: rankOf(e) }));
    // A per-strength family saved as "this strength or stronger" (max above 1) gets a row for each
    // stronger strength too, at the same priority (rank 1 when the saved one was required)
    if (!legacy && max > 1 && perStrength(gd, effect)) {
      for (const m of familyOf(gd, effect)) {
        if (m.level <= effect.level || seen.has(m.key) || (stored.effects ?? []).some((x) => x.slug === m.slug)) continue;
        seen.add(m.key);
        build.wanted.push(fitStacks(gd, { effectKey: m.key, minStacks: 0, maxStacks: 1, rank: (e.min ?? 0) > 0 ? 1 : rankOf(e) }));
      }
    }
  }
  build.wanted = mergeFamilies(gd, build.wanted);
  for (const e of stored.avoid ?? []) {
    const effect = bySlug.get(e.slug);
    if (!effect) { missing++; continue; }
    addAvoid(effect, e, e.block === true);
  }
  return { build, missing };
}

export function toStored(gd, build) {
  const slug = (k) => gd.effectByKey(k).slug;
  return {
    id: build.id,
    name: build.name,
    nightfarer: build.nightfarer,
    excludeDeepEffects: !build.includeDeep,
    cursePenalty: build.cursePenalty,
    effects: build.wanted.map((e) => ({ slug: slug(e.effectKey), min: e.minStacks, max: e.maxStacks, priority: e.rank })),
    avoid: build.avoid.map((a) => ({ slug: slug(a.effectKey), priority: a.rank, ...(a.block && { block: true }) })),
  };
}

export function emptyBuild(id, name, nightfarer) {
  return { id, name, nightfarer, includeDeep: true, cursePenalty: "light", wanted: [], avoid: [] };
}

export const newWanted = (gd, effect) => fitStacks(gd, { effectKey: effect.key, minStacks: 0, maxStacks: 10, rank: DEFAULT_RANK });

/** All strengths of `effect`'s family from weakest to strongest, or null when it has only one. */
export function familyOf(gd, effect) {
  let cache = families.get(gd);
  if (!cache) families.set(gd, (cache = new Map()));
  if (effect.group === undefined || effect.level === undefined) return null;
  if (!cache.has(effect.group)) {
    const members = gd.effectsByKey
      .filter((e) => e && !e.unknown && !e.mmv && e.level !== undefined && isSameGroup(e, effect))
      .sort((a, b) => a.level - b.level);
    cache.set(effect.group, members.length > 1 ? members : null);
  }
  return cache.get(effect.group);
}
const families = new WeakMap();

/** True when every strength of the family is a separate bonus that doesn't stack with itself. */
export const perStrength = (gd, effect) => Boolean(familyOf(gd, effect)?.every((e) => !e.stacks));

/** True when the entry means "this strength or stronger" (stacking families). */
export const orBetterFamily = (gd, effect) => Boolean(familyOf(gd, effect)) && !perStrength(gd, effect);

/** Family name without the strength suffix: "Physical Attack Up +2" -> "Physical Attack Up". */
export function familyName(gd, effect) {
  const family = familyOf(gd, effect);
  return (family ? family[0] : effect).name.replace(/\s*\+\d+$/, "");
}

/**
 * Keeps an entry's stack range valid for its effect: 0-10 when copies stack or different strengths of
 * its family can add up, otherwise at most 1.
 */
export function fitStacks(gd, entry) {
  const effect = gd.effectByKey(entry.effectKey);
  // Several counts are possible when copies stack, or when stronger strengths of the family count too
  const counts = effect.stacks || (orBetterFamily(gd, effect) && familyOf(gd, effect).some((e) => e !== effect && e.level >= effect.level));
  const maxStacks = counts ? Math.min(Math.max(entry.maxStacks, 1), 10) : 1;
  const minStacks = Math.min(Math.max(entry.minStacks, 0), maxStacks);
  return { ...entry, minStacks, maxStacks };
}

/**
 * One entry per family. Older builds could list several strengths of the same effect; keep the most
 * important one (required first, then rank, then the weaker strength, which also matches stronger ones).
 */
export function mergeFamilies(gd, wanted) {
  const byFamily = new Map();
  const out = [];
  for (const entry of wanted) {
    const effect = gd.effectByKey(entry.effectKey);
    const family = familyOf(gd, effect);
    if (!family || perStrength(gd, effect)) { out.push(entry); continue; }
    const prev = byFamily.get(effect.group);
    if (!prev) { byFamily.set(effect.group, entry); out.push(entry); continue; }
    const better = (a, b) => (a.minStacks > 0) - (b.minStacks > 0) || b.rank - a.rank || gd.effectByKey(b.effectKey).level - gd.effectByKey(a.effectKey).level;
    const keep = better(entry, prev) > 0 ? entry : prev;
    const merged = { ...keep, rank: Math.min(entry.rank, prev.rank) };
    out[out.indexOf(prev)] = merged;
    byFamily.set(effect.group, merged);
  }
  return out;
}
export const newAvoid = (effect) => ({ effectKey: effect.key, block: true, rank: 5 });

export function summary(build) {
  const req = build.wanted.filter((e) => e.minStacks > 0).length;
  const parts = [];
  if (req) parts.push(`${req} required`);
  if (build.wanted.length - req) parts.push(`${build.wanted.length - req} wanted`);
  if (build.avoid.length) parts.push(`${build.avoid.length} avoided`);
  return parts.join(" · ") || "empty";
}

/** Order-independent fingerprint of a build's effects, to spot duplicates. */
export function signature(build) {
  return JSON.stringify([
    build.nightfarer, build.includeDeep, build.cursePenalty,
    build.wanted.map((e) => `${e.effectKey}:${e.minStacks}:${e.maxStacks}:${e.minStacks > 0 ? "r" : clampRank(e.rank)}`).sort(),
    build.avoid.map((a) => `${a.effectKey}:${a.block ? "b" : clampRank(a.rank)}`).sort(),
  ]);
}

export const slugIndex = (gd) => new Map(gd.effectsByKey.filter((e) => e && !e.unknown).map((e) => [e.slug, e]));
