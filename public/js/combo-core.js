// Combo Finder engine: a JS port of upstream's Rust/WASM search (wasm/combo_search/src/lib.rs)
// plus the input preparation from src/utils/ComboSearch.ts (MIT, metinc/nightreign-relic-browser).
//
// Scoring math emulates Rust f32 exactly (Math.fround on every operation) so results can be
// diff-tested against a native build of the original. Three upstream behaviors are fixed by
// default and can be re-enabled for diff testing (see README "Differences from upstream"):
//   upstreamGroupSpace:      effect groups >= 30 were never tracked for duplicate detection
//                            (array sized 30; groups go up to 66)
//   upstreamEffectLimits:    > 27 expanded selected or > 35 recommended effects returned no
//                            results, which after expansion hits 9 of the 10 Nightfarers
//   upstreamGroupDuplicates: another level of a NON-stacking group effect counted as a wasted
//                            duplicate. Upstream's own data docs say those levels stack with each
//                            other (e.g. "Defeating enemies fills more of the Art gauge" + "+1"),
//                            so by default only stackable effects treat same-group as duplicate.
//   upstreamShortlist:       each vessel half keeps only its 200 best triples *before* stack
//                            requirements are checked, so a build that needs a low-scoring relic
//                            (the only one with a required effect) is silently missed. By default
//                            the best triples are also kept per requirement-coverage signature and
//                            only halves that can jointly satisfy the requirements are paired, which
//                            guarantees a valid build is found whenever one exists.
// `compat: true` turns all of these on.
//
// Optimizer extensions (neutral unless the input sets them, so diff tests stay exact):
//   input.effect_weights: [[effectKey, weight]] multiplies a selected effect's points (priority)
//   input.curse_penalty:  points subtracted for each curse that is not itself selected

import { Color, EffectType, isSameGroupAndEqualOrBetter, relicHasEffect } from "./game-data.js";

const f = Math.fround;
const P_SELECTED = f(1.0);
const P_SELECTED_DUP = f(0.9);
const P_CHARACTER = f(0.2);
const P_RECOMMENDED = f(0.2);
const P_RANDOM = f(0.1);
const PENALTY_MISSING_LEVEL = f(-0.1);

export const TOP_RESULTS = 50;
const TOP_GROUP_RESULTS = 200;
const BUCKET_RESULTS = 20; // per requirement signature
const TRACK_MAX_BELOW = 10; // a max-stacks limit below this is tracked exactly in signatures
const UPSTREAM_GROUP_SPACE = 30;
const UPSTREAM_KEY_SPACE = 850;
const SENTINEL = 1023;
const FIELDS = 7; // key, nightfarer, stacks, group, level, startingBonus, isDebuff

// ---------------------------------------------------------------------------
// Input preparation (main thread) — port of ComboSearch.ts buildWorkerInput/filterRelics
// ---------------------------------------------------------------------------

function filterRelics(relics, effects, enabledVessels, deep, blockedKeys, blockedEffects) {
  const slotIdx = deep ? [3, 4, 5] : [0, 1, 2];
  const enabledColors = new Set(slotIdx.flatMap((i) => enabledVessels.map((v) => v.slots[i])));
  const blocked = new Set(blockedKeys);
  // A relic carrying an excluded effect (max stacks 0) can never be part of a valid combo.
  // Upstream only rejected such combos at the very end, after they had taken up room in the
  // per-group shortlists; dropping them here keeps those slots for usable relics.
  const carriesBlocked = (relic) => relic.effects.flat().some((e) =>
    blockedEffects.some((b) => b === e || (b.stacks && isSameGroupAndEqualOrBetter(b, e))));
  relics = relics.filter((r) => !carriesBlocked(r));

  const filtered = relics.filter((relic) => {
    if (relic.item.unknown || relic.item.color === null) return false;
    if (!enabledColors.has(relic.color) && !enabledColors.has(Color.Any)) return false;
    return effects.some((effect) => relicHasEffect(relic, effect) && !blocked.has(effect.key));
  });

  // Gap filling: add up to 10 extra relics per color so vessels can be completed
  // with the best "filler" relics (most effects first, then ones touching selected effects).
  const effectSet = new Set(effects);
  for (const color of [Color.Red, Color.Blue, Color.Yellow, Color.Green]) {
    const already = new Set(filtered.filter((r) => r.color === color));
    const candidates = relics
      .map((relic, index) => ({ relic, index }))
      .filter(({ relic }) =>
        !relic.item.unknown && relic.item.color === color && !already.has(relic) &&
        !relic.effects.some(([e, c]) => blocked.has(e.key) || (c !== undefined && blocked.has(c.key))))
      .map(({ relic, index }) => ({
        relic,
        index,
        effectCount: relic.effects.length,
        hasMatching: relic.effects.some(([e]) => effectSet.has(e)),
      }));
    candidates.sort((a, b) =>
      b.effectCount - a.effectCount || Number(b.hasMatching) - Number(a.hasMatching) || a.index - b.index);
    filtered.push(...candidates.slice(0, 10).map((c) => c.relic));
  }
  return filtered;
}

/**
 * @param selectedEntries [{ effectKey, minStacks, maxStacks, weight? }]
 * @param cursePenalty    points lost per unselected curse (0 = upstream behavior)
 * Returns { input, relics, deepRelics } where `input` is the plain, structured-cloneable
 * search input (same shape as upstream's WASM SearchInput) and relics/deepRelics map
 * result indices back to relic objects.
 */
export function buildSearch(gd, { nightfarer, selectedEffects, relics, deepRelics, enabledVessels, selectedEntries, cursePenalty = 0 }) {
  const expanded = selectedEffects.flatMap(gd.stackableHigherLevel);
  // A priority set on "Physical Attack Up" applies to the +1..+4 levels it expands to
  const weights = new Map();
  for (const effect of selectedEffects) {
    const w = selectedEntries.find((e) => e.effectKey === effect.key)?.weight ?? 1;
    if (w === 1) continue;
    for (const e of gd.stackableHigherLevel(effect)) weights.set(e.key, Math.max(weights.get(e.key) ?? 0, w));
  }
  const expandedKeys = new Set(expanded.map((e) => e.key));
  const recommended = (gd.recommended[nightfarer] ?? []).filter((e) => !expandedKeys.has(e.key));
  const effects = [...expanded, ...recommended];
  const blockedKeys = selectedEntries.filter((e) => e.maxStacks === 0).map((e) => e.effectKey);
  const blockedEffects = blockedKeys.map((k) => gd.effectByKey(k)).filter(Boolean);

  const normal = filterRelics(relics, effects, enabledVessels, false, blockedKeys, blockedEffects);
  const deep = filterRelics(deepRelics, effects, enabledVessels, true, blockedKeys, blockedEffects);

  const toEffect = (e) => ({
    key: e.key, nightfarer: e.nightfarer, stacks: e.stacks, group: e.group,
    level: e.level, startingBonus: e.startingBonus, type: e.type,
  });
  const input = {
    nightfarer,
    selected_effects: expanded.map(toEffect),
    recommended_effects: recommended.map(toEffect),
    relics: normal.map((r) => ({ color: r.color, effects: r.effects.map(([e]) => toEffect(e)) })),
    deep_relics: deep.map((r) => ({ color: r.color, effects: r.effects.flat().map(toEffect) })),
    enabled_vessels: enabledVessels.map((v) => v.slots),
    selected_effect_ranges: selectedEntries.map((e) => ({ effect_key: e.effectKey, min_stacks: e.minStacks, max_stacks: e.maxStacks })),
  };
  if (weights.size) input.effect_weights = [...weights];
  if (cursePenalty) input.curse_penalty = cursePenalty;
  return { input, relics: normal, deepRelics: deep };
}

// ---------------------------------------------------------------------------
// Search (worker) — faithful port of lib.rs
// ---------------------------------------------------------------------------

const opt = (v) => (v === undefined || v === null ? -1 : typeof v === "boolean" ? Number(v) : v);

function packRelic(relic) {
  const arr = new Int32Array(relic.effects.length * FIELDS);
  relic.effects.forEach((e, i) => {
    arr.set([e.key, opt(e.nightfarer), e.stacks ? 1 : 0, opt(e.group), opt(e.level), opt(e.startingBonus), e.type === EffectType.Debuff ? 1 : 0], i * FIELDS);
  });
  return arr;
}

/** Sorted 3x10-bit key of a triple, order independent (pack_triple_key). */
function packTriple(a, b, c) {
  let x = a < 0 ? SENTINEL : a, y = b < 0 ? SENTINEL : b, z = c < 0 ? SENTINEL : c, t;
  if (x > y) { t = x; x = y; y = t; }
  if (y > z) { t = y; y = z; z = t; }
  if (x > y) { t = x; x = y; y = t; }
  return x | (y << 10) | (z << 20);
}
// 60-bit key in upstream; a JS number only holds 53 bits exactly, so use a string.
const key6 = (i) => `${packTriple(i[0], i[1], i[2])}:${packTriple(i[3], i[4], i[5])}`;

export function prepareSearch(input, { compat = false, upstreamGroupSpace = compat, upstreamEffectLimits = compat, upstreamGroupDuplicates = compat, upstreamShortlist = compat } = {}) {
  const maxKey = Math.max(
    0,
    ...[input.selected_effects, input.recommended_effects, ...input.relics.map((r) => r.effects), ...input.deep_relics.map((r) => r.effects)]
      .flat().map((e) => e.key),
  );
  const maxGroup = Math.max(0, ...[...input.relics, ...input.deep_relics].flatMap((r) => r.effects).map((e) => e.group ?? 0));
  const keySpace = upstreamGroupSpace ? UPSTREAM_KEY_SPACE : maxKey + 1;
  const groupSpace = upstreamGroupSpace ? UPSTREAM_GROUP_SPACE : maxGroup + 1;

  const selected = new Uint8Array(keySpace);
  const selGroup = new Int32Array(keySpace).fill(-1);
  const selLevel = new Int32Array(keySpace).fill(-1);
  for (const e of input.selected_effects) {
    if (e.key >= keySpace) continue;
    selected[e.key] = 1;
    if (e.group !== undefined && e.group !== null) selGroup[e.key] = e.group;
    if (e.level !== undefined && e.level !== null) selLevel[e.key] = e.level;
  }
  const weight = new Float32Array(keySpace).fill(1);
  for (const [k, w] of input.effect_weights ?? []) if (k < keySpace) weight[k] = w;
  const recommended = new Uint8Array(keySpace);
  for (const e of input.recommended_effects) if (e.key < keySpace) recommended[e.key] = 1;

  const byColor = (relics) => {
    const lists = [[], [], [], [], []];
    relics.forEach((r, i) => { if (r.color > 0 && r.color < 5) lists[r.color].push(i); });
    lists[Color.Any] = relics.map((_, i) => i);
    return lists;
  };

  const ranges = (input.selected_effect_ranges ?? []).map((r) => [r.effect_key, r.min_stacks, r.max_stacks]);
  const normal = input.relics.map(packRelic);
  const deep = input.deep_relics.map(packRelic);

  // Requirement signature dimensions: ranges with a minimum, or a small maximum.
  const dims = [];
  if (!upstreamShortlist) {
    ranges.forEach(([, min, max], i) => {
      const trackMax = max < TRACK_MAX_BELOW;
      if (min > 0 || trackMax) dims.push({ range: i, min, max: trackMax ? max : Infinity, cap: trackMax ? max : min });
    });
  }
  let radix = 1;
  for (const d of dims) { d.radix = radix; radix *= d.cap + 1; }

  const ctx = {
    nightfarer: input.nightfarer,
    keySpace,
    groupSpace,
    selected,
    weight,
    weighted: (input.effect_weights ?? []).some(([, w]) => w !== 1),
    cursePenalty: f(input.curse_penalty ?? 0),
    groupDupForAll: upstreamGroupDuplicates,
    selGroup,
    selLevel,
    recommended,
    normal,
    deep,
    dims,
    normalColors: input.relics.map((r) => r.color ?? -1),
    deepColors: input.deep_relics.map((r) => r.color ?? -1),
    byColorNormal: byColor(input.relics),
    byColorDeep: byColor(input.deep_relics),
    vessels: input.enabled_vessels,
    ranges,
    tooMany: upstreamEffectLimits && (input.selected_effects.length > 27 || input.recommended_effects.length > 35),
    keyGen: new Uint32Array(keySpace),
    groupGen: new Uint32Array(groupSpace),
    gen: 0,
  };
  if (dims.length) {
    // Per relic: how many stacks it contributes to each tracked requirement
    const perRelic = (fx) => {
      const all = rangeCounts(ctx, [fx]);
      return Uint8Array.from(dims, (d) => all[d.range]);
    };
    ctx.reqNormal = normal.map(perRelic);
    ctx.reqDeep = deep.map(perRelic);
  }
  return ctx;
}

function calcPoints(ctx, idx6) {
  const gen = ++ctx.gen;
  const { keyGen, groupGen, keySpace, groupSpace, selected, recommended, nightfarer, groupDupForAll, weight, weighted, cursePenalty } = ctx;
  let points = 0;
  let sbMask = 0;
  for (let s = 0; s < 6; s++) {
    const ri = idx6[s];
    if (ri < 0) continue;
    const fx = s < 3 ? ctx.normal[ri] : ctx.deep[ri];
    for (let o = 0; o < fx.length; o += FIELDS) {
      const nf = fx[o + 1];
      const isChar = nf >= 0;
      const usableChar = nf === nightfarer;
      if (isChar && !usableChar) continue;
      const sb = fx[o + 5];
      if (sb >= 0) {
        const bit = 1 << (sb & 7);
        if (sbMask & bit) continue;
        sbMask |= bit;
      }
      const k = fx[o];
      if (k >= keySpace) continue;
      const g = fx[o + 3];
      const inGroupSpace = g >= 0 && g < groupSpace;
      const stacks = fx[o + 2] === 1;
      const dup = keyGen[k] === gen || ((stacks || groupDupForAll) && inGroupSpace && groupGen[g] === gen);
      if (dup && !stacks) continue;
      const isSel = selected[k] === 1;
      const lvl = fx[o + 4];
      const mult = lvl >= 0 ? f(1 + f((3 - lvl) * PENALTY_MISSING_LEVEL)) : 1;
      const debuff = fx[o + 6] === 1;
      if (debuff && !isSel && cursePenalty !== 0) points = f(points - cursePenalty);
      if (!(debuff && !isSel)) {
        if (isSel) {
          const base = f((dup ? P_SELECTED_DUP : P_SELECTED) * mult);
          points = f(points + (weighted ? f(base * weight[k]) : base));
        }
        else if (usableChar && !dup) points = f(points + f(P_CHARACTER * mult));
        else if (!isChar) points = f(points + f((recommended[k] === 1 ? P_RECOMMENDED : P_RANDOM) * mult));
      }
      keyGen[k] = gen;
      if (inGroupSpace) groupGen[g] = gen;
    }
  }
  return points;
}

/** Stack counts per requested range for a list of packed relics (combination_satisfies_ranges). */
function rangeCounts(ctx, relicFx) {
  const { ranges, nightfarer, selGroup, selLevel, keySpace } = ctx;
  const counts = new Uint8Array(ranges.length);
  for (const fx of relicFx) {
    for (let o = 0; o < fx.length; o += FIELDS) {
      const nf = fx[o + 1];
      if (nf >= 0 && nf !== nightfarer) continue;
      const k = fx[o], g = fx[o + 3], l = fx[o + 4], stacks = fx[o + 2] === 1;
      for (let i = 0; i < ranges.length; i++) {
        const want = ranges[i][0];
        let match = k === want;
        if (!match && want < keySpace) {
          const sg = selGroup[want], sl = selLevel[want];
          if (sg >= 0 && sl >= 0 && g >= 0 && l >= 0 && stacks && g === sg && l >= sl) match = true;
        }
        if (match && counts[i] < 255) counts[i]++;
      }
    }
  }
  return counts;
}

function satisfiesRanges(ctx, idx6) {
  const { ranges } = ctx;
  if (ranges.length === 0) return true;
  const fx = [];
  for (let s = 0; s < 6; s++) if (idx6[s] >= 0) fx.push(s < 3 ? ctx.normal[idx6[s]] : ctx.deep[idx6[s]]);
  const counts = rangeCounts(ctx, fx);
  for (let i = 0; i < ranges.length; i++) {
    if (counts[i] < ranges[i][1] || counts[i] > ranges[i][2]) return false;
  }
  return true;
}

/** Bounded top-K that replaces the current minimum, matching upstream's tie behavior exactly. */
class TopK {
  constructor(k) { this.k = k; this.items = []; this.minI = 0; this.minP = Infinity; }
  offer(item, points) {
    const items = this.items;
    if (items.length < this.k) {
      items.push([item, points]);
      if (points < this.minP) { this.minI = items.length - 1; this.minP = points; }
      return;
    }
    if (points <= this.minP) return;
    items[this.minI] = [item, points];
    let mi = 0, mp = items[0][1];
    for (let i = 1; i < items.length; i++) if (items[i][1] < mp) { mp = items[i][1]; mi = i; }
    this.minI = mi; this.minP = mp;
  }
}

/**
 * Enumerates relic triples for one half of a vessel (normal slots 0-2 or deep slots 3-5),
 * scores each in isolation and keeps the best 200.
 *
 * Emission order is identical to upstream's anchor loop; duplicates it would have discarded
 * after scoring are skipped up front instead:
 *  - every full triple produced with anchor slot 1 or 2 was already produced with anchor 0,
 *  - within anchor 0, a set is kept only at its first (lexicographically smallest) assignment.
 * Only partial triples (an empty slot) need a seen-set.
 */
function searchGroup(ctx, slotColors, deep) {
  const lists = deep ? ctx.byColorDeep : ctx.byColorNormal;
  const colors = deep ? ctx.deepColors : ctx.normalColors;
  const top = new TopK(TOP_GROUP_RESULTS);
  const seenPartial = new Set();
  let checked = 0;
  // Requirement-aware shortlist: best triples per coverage signature
  const dims = ctx.dims;
  const req = deep ? ctx.reqDeep : ctx.reqNormal;
  const buckets = dims.length ? new Map() : null;
  const offer = (t, points) => {
    top.offer(t, points);
    if (!buckets) return;
    let sig = 0;
    const vals = new Uint8Array(dims.length);
    for (let d = 0; d < dims.length; d++) {
      const v = (t[0] >= 0 ? req[t[0]][d] : 0) + (t[1] >= 0 ? req[t[1]][d] : 0) + (t[2] >= 0 ? req[t[2]][d] : 0);
      if (v > dims[d].max) return; // this half alone already breaks a max — never valid
      vals[d] = Math.min(v, dims[d].cap);
      sig += vals[d] * dims[d].radix;
    }
    let b = buckets.get(sig);
    if (!b) buckets.set(sig, (b = { vals, top: new TopK(BUCKET_RESULTS) }));
    b.top.offer(t, points);
  };
  const idx6 = [-1, -1, -1, -1, -1, -1];
  const base = deep ? 3 : 0;
  const listFor = (c) => (c >= 0 && c < 5 ? lists[c] : []);
  const fits = (slot, relic) => slotColors[slot] === Color.Any || colors[relic] === slotColors[slot];

  const score = (t0, t1, t2) => {
    idx6[base] = t0; idx6[base + 1] = t1; idx6[base + 2] = t2;
    const p = calcPoints(ctx, idx6);
    idx6[base] = idx6[base + 1] = idx6[base + 2] = -1;
    return p;
  };
  const emitPartial = (t) => {
    checked++;
    const key = packTriple(t[0], t[1], t[2]);
    if (seenPartial.has(key)) return;
    seenPartial.add(key);
    offer(t, score(t[0], t[1], t[2]));
  };
  // Is (x, y, z) in slots (0, 1, 2) the first assignment of this set in anchor-0 order?
  const isFirstAssignment = (x, y, z) => {
    const perms = [[x, z, y], [y, x, z], [y, z, x], [z, x, y], [z, y, x]];
    for (const [p0, p1, p2] of perms) {
      if (!fits(0, p0) || !fits(1, p1) || !fits(2, p2)) continue;
      if (p0 < x || (p0 === x && (p1 < y || (p1 === y && p2 < z)))) return false;
    }
    return true;
  };

  for (let anchor = 0; anchor < 3; anchor++) {
    const anchorList = listFor(slotColors[anchor]);
    if (anchorList.length === 0) continue;
    const [oa, ob] = anchor === 0 ? [1, 2] : anchor === 1 ? [0, 2] : [0, 1];
    const listA = listFor(slotColors[oa]);
    const listB = listFor(slotColors[ob]);
    const place = (c, a, b) => {
      const t = [-1, -1, -1];
      t[anchor] = c; t[oa] = a; t[ob] = b;
      return t;
    };
    for (const c of anchorList) {
      const aHasC = fits(oa, c), bHasC = fits(ob, c);
      const nA = listA.length - (aHasC ? 1 : 0);
      const nB = listB.length - (bHasC ? 1 : 0);
      if (nA === 0 && nB === 0) { emitPartial(place(c, -1, -1)); continue; }
      if (nA > 0 && nB > 0) {
        // Pairs (a, b) with a != b, a != c, b != c
        let shared = 0; // |validA ∩ validB|
        for (const a of listA) if (a !== c && fits(ob, a)) shared++;
        const pairs = nA * nB - shared;
        if (pairs === 0) {
          const a0 = listA.find((a) => a !== c);
          emitPartial(place(c, a0, -1));
          continue;
        }
        checked += pairs;
        if (anchor !== 0) continue; // all full triples here are repeats of anchor 0
        for (const a of listA) {
          if (a === c) continue;
          for (const b of listB) {
            if (b === c || b === a) continue;
            if (!isFirstAssignment(c, a, b)) continue;
            offer([c, a, b], score(c, a, b));
          }
        }
        continue;
      }
      if (nA > 0) { for (const a of listA) if (a !== c) emitPartial(place(c, a, -1)); }
      else { for (const b of listB) if (b !== c) emitPartial(place(c, -1, b)); }
    }
  }
  if (top.items.length === 0) top.items.push([[-1, -1, -1], 0]);
  if (buckets && buckets.size === 0) {
    // An empty half (signature all zero) so the other half can still be paired with nothing
    const empty = new TopK(1);
    empty.offer([-1, -1, -1], 0);
    buckets.set(0, { vals: new Uint8Array(dims.length), top: empty });
  }
  return { triples: top.items, checked, buckets };
}

/** Searches the given vessel indices; returns per-vessel results in order (for merging). */
export function searchVessels(ctx, vesselIndices) {
  const out = [];
  for (const v of vesselIndices) {
    const slots = ctx.vessels[v];
    const top = new TopK(TOP_RESULTS);
    let checked = 0;
    if (!ctx.tooMany) {
      const n = searchGroup(ctx, [slots[0], slots[1], slots[2]], false);
      const d = searchGroup(ctx, [slots[3], slots[4], slots[5]], true);
      checked += n.checked + d.checked;
      const seen = n.buckets ? new Set() : null;
      for (const [nt] of n.triples) {
        for (const [dt] of d.triples) {
          checked++;
          const idx6 = [nt[0], nt[1], nt[2], dt[0], dt[1], dt[2]];
          if (idx6.every((x) => x < 0)) continue;
          // Upstream dedupes here too, but both triple lists are already unique sets,
          // so every (normal, deep) pair is distinct and the check can never fire.
          seen?.add(key6(idx6));
          if (!satisfiesRanges(ctx, idx6)) continue;
          top.offer(idx6, calcPoints(ctx, idx6));
        }
      }
      if (n.buckets) {
        // Pair only halves whose requirement signatures can add up to a valid build
        const dims = ctx.dims;
        const fits = (a, b) => dims.every((dim, i) => a[i] + b[i] >= dim.min && a[i] + b[i] <= dim.max);
        for (const bn of n.buckets.values()) {
          for (const bd of d.buckets.values()) {
            if (!fits(bn.vals, bd.vals)) continue;
            for (const [nt] of bn.top.items) {
              for (const [dt] of bd.top.items) {
                const idx6 = [nt[0], nt[1], nt[2], dt[0], dt[1], dt[2]];
                if (idx6.every((x) => x < 0)) continue;
                const k = key6(idx6);
                if (seen.has(k)) continue;
                seen.add(k);
                checked++;
                if (!satisfiesRanges(ctx, idx6)) continue;
                top.offer(idx6, calcPoints(ctx, idx6));
              }
            }
          }
        }
      }
    }
    out.push({ vessel: v, results: top.items, checked });
  }
  return out;
}

/** Merges per-vessel results (in vessel order) exactly like upstream's final reduce. */
export function mergeResults(perVessel) {
  const index = new Map();
  const results = [];
  let checked = 0;
  for (const { vessel, results: list, checked: c } of perVessel) {
    checked = (checked + c) >>> 0; // u32 like upstream
    for (const [idx6, points] of list) {
      const k = key6(idx6);
      const at = index.get(k);
      if (at !== undefined) {
        if (points > results[at].points) results[at] = { vessel, idx6, points };
      } else {
        index.set(k, results.length);
        results.push({ vessel, idx6, points });
      }
    }
  }
  results.sort((a, b) => b.points - a.points);
  return { combinations: results.slice(0, TOP_RESULTS), checked };
}

/** Single-threaded convenience used by tests and as a fallback when workers are unavailable. */
export function runSearch(input, options) {
  const ctx = prepareSearch(input, options);
  return mergeResults(searchVessels(ctx, input.enabled_vessels.map((_, i) => i)));
}
