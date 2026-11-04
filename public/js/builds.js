// Builds: a named set of wanted and avoided effects for one Nightfarer. Stored by effect slug
// so they survive data updates. Shape on disk (presets.json and localStorage):
//   { id, name, nightfarer, excludeDeepEffects, cursePenalty,
//     effects: [{ slug, min, max, priority }],          // wanted; min >= 1 means required
//     avoid:   [{ slug, priority, block? }] }           // block = never allowed, else a soft penalty
// Older builds kept curses and exclusions in `effects` (max 0 = excluded); those load into `avoid`.
import { EffectType } from "./game-data.js";
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
  for (const e of stored.effects ?? []) {
    const effect = bySlug.get(e.slug);
    if (!effect) { missing++; continue; }
    const max = e.max ?? (effect.stacks ? 10 : 1);
    // Curses are never wanted: an old "selected" curse becomes a soft avoid at the same priority
    if (max === 0 || effect.type === EffectType.Debuff) { addAvoid(effect, e, max === 0); continue; }
    if (seen.has(effect.key)) continue;
    seen.add(effect.key);
    const cap = effect.stacks ? 10 : 1;
    const maxStacks = Math.min(Math.max(max, 1), cap);
    build.wanted.push({ effectKey: effect.key, minStacks: Math.min(Math.max(e.min ?? 0, 0), maxStacks), maxStacks, rank: rankOf(e) });
  }
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

export const newWanted = (effect) => ({ effectKey: effect.key, minStacks: 0, maxStacks: effect.stacks ? 10 : 1, rank: DEFAULT_RANK });
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
