// Dev tool: runs randomized Combo Finder scenarios through both this JS engine
// and a native build of upstream's original Rust search, and checks the results are identical.
//
//   node scripts/diff-vs-rust.mjs <combo_ref.exe> <save.sl2> [scenarios=40] [seed=1] [mode=compat]
//
// mode selects which JS options must match the binary:
//   compat      upstream exactly                 vs. unmodified lib.rs
//   limits      effect-count limits lifted       vs. lib.rs with SELECTED/RECOMMENDED_EFFECTS_SPACE raised
//   groups128   ...and all 67 groups tracked     vs. the above + EFFECT_GROUP_SPACE=128
//   documented  app default minus the            vs. the above + group_duplicate only for stackable effects
//               requirement-aware shortlist
//
// combo_ref.exe = upstream wasm/combo_search/src/lib.rs with only the wasm-bindgen glue removed,
// reading the SearchInput JSON on stdin and printing SearchOutput JSON.
import { spawnSync } from "node:child_process";
import { buildSearch, runSearch } from "../public/js/combo-core.js";
import { EffectType } from "../public/js/game-data.js";
import { availableEffects } from "../public/js/model.js";
import { comboRequest, loadCharacters, loadGameData } from "../test/helpers.mjs";

const [exe, save, n = "40", seedArg = "1", mode = "compat"] = process.argv.slice(2);
const jsOptions = {
  compat: { compat: true },
  // The requirement-aware shortlist has no Rust counterpart, so it is off in the non-compat modes
  limits: { upstreamGroupSpace: true, upstreamEffectLimits: false, upstreamGroupDuplicates: true, upstreamShortlist: true },
  groups128: { upstreamGroupSpace: false, upstreamEffectLimits: false, upstreamGroupDuplicates: true, upstreamShortlist: true },
  documented: { upstreamShortlist: true },
}[mode];
if (!jsOptions) throw new Error(`unknown mode ${mode}`);
if (!exe || !save) {
  console.error("usage: node scripts/diff-vs-rust.mjs <combo_ref.exe> <save.sl2> [scenarios] [seed]");
  process.exit(2);
}

let seed = Number(seedArg);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const gd = loadGameData({ raw: true }); // upstream's own stacking flags, as the Rust build sees them
const characters = (await loadCharacters(save, gd)).filter((c) => c.relics.length > 0);
let failures = 0, jsMs = 0, rustMs = 0;

for (let s = 0; s < Number(n); s++) {
  const character = pick(characters);
  const nightfarer = pick(gd.nightfarers).id;
  const excludeDeep = rand() < 0.2;
  const pool = availableEffects(character).filter((e) =>
    (e.nightfarer === undefined || e.nightfarer === nightfarer) && (!excludeDeep || e.type !== EffectType.Debuff));
  const effectKeys = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(pool).key))];
  const disabledVessels = gd.nightfarers[nightfarer].vessels.map((_, i) => i).filter(() => rand() < 0.25);
  const ranges = {};
  for (const k of effectKeys) if (rand() < 0.3) { const lo = Math.floor(rand() * 2); ranges[k] = [lo, lo + Math.floor(rand() * 3)]; }
  const req = comboRequest(gd, character, { nightfarer, effectKeys, disabledVessels, excludeDeep, ranges });
  if (req.enabledVessels.length === 0) continue;
  const { input } = buildSearch(gd, req);

  let t = performance.now();
  const js = runSearch(input, jsOptions);
  jsMs += performance.now() - t;

  t = performance.now();
  const proc = spawnSync(exe, { input: JSON.stringify(input), maxBuffer: 64 << 20 });
  rustMs += performance.now() - t;
  if (proc.status !== 0) throw new Error(proc.stderr.toString());
  const rust = JSON.parse(proc.stdout.toString());

  const norm = (c) => `${c.vessel}|${c.idx6.join(",")}|${c.points}`;
  const a = js.combinations.map(norm);
  const b = rust.combinations.map((c) => norm({
    vessel: c.vessel_index, idx6: c.relic_indices.map((x) => (x === null ? -1 : x)), points: Math.fround(c.points),
  }));
  const same = a.length === b.length && a.every((x, i) => x === b[i]) && js.checked === rust.total_combinations_checked;
  const label = `#${s} ${gd.nightfarers[nightfarer].name} effects=[${effectKeys.map((k) => gd.effectByKey(k).name).join("; ")}] vessels=${req.enabledVessels.length} relics=${input.relics.length}+${input.deep_relics.length}`;
  if (same) {
    console.log(`ok   ${label} -> ${a.length} combos, ${js.checked} checked`);
  } else {
    failures++;
    console.log(`FAIL ${label}\n  js   ${a.length} combos checked=${js.checked}: ${a.slice(0, 3).join("  ")}\n  rust ${b.length} combos checked=${rust.total_combinations_checked}: ${b.slice(0, 3).join("  ")}`);
    const firstDiff = a.findIndex((x, i) => x !== b[i]);
    if (firstDiff >= 0) console.log(`  first difference at rank ${firstDiff}: js=${a[firstDiff]} rust=${b[firstDiff]}`);
  }
}
console.log(`\nmode=${mode} ${failures === 0 ? "ALL IDENTICAL" : `${failures} FAILURES`} | js total ${jsMs.toFixed(0)} ms (single thread), rust total ${rustMs.toFixed(0)} ms (multi-thread, incl. process spawn)`);
process.exit(failures ? 1 : 0);
