// Relic Vault — main UI.
import { buildSearch } from "./combo-core.js";
import { SearchCancelled, cancelSearch, lastDiagnostics, searchCombos } from "./combo-client.js";
import { Color, EffectType, ItemType, RELIC_COLORS, createGameData, isSameGroup, isSameGroupAndEqualOrBetter } from "./game-data.js";
import { availableEffects as computeAvailableEffects, buildCharacter } from "./model.js";
import { emptyBuild, familyName, familyOf, fitStacks, fromStored, newAvoid, newWanted, orBetterFamily, perStrength, signature, summary, toStored } from "./builds.js";
import { MAX_RANK, avoidPenaltyForRank, clampRank, rankLabel, wantedWeight, weightForRank } from "./priority.js";
import { SaveParseError, parseSave } from "./save-parser.js";
import { $, banner, colorChip, effectPicker, esc, relicCard, timeAgo, toast } from "./ui.js";

// ---------------------------------------------------------------------------
// Persistence (per-browser conveniences only; everything works without it)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`relicvault:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`relicvault:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable (private window etc.)
    }
  },
};

const COLOR_FILTERS = [
  { type: undefined, color: Color.Any },
  ...RELIC_COLORS.map((color) => ({ type: ItemType.Relic, color })),
  ...RELIC_COLORS.map((color) => ({ type: ItemType.DeepRelic, color })),
];
// Character-bound effects that upstream still lets every Nightfarer pick
const ALWAYS_SELECTABLE = new Set(["improvedPoiseNearTotemStela", "defeatingEnemiesNearTotemStelaRestoresHP"]);

// Optimizer knobs layered on top of upstream's scoring
const CURSE_PENALTY = { off: { value: 0, label: "Ignore" }, light: { value: 0.15, label: "Light" }, strong: { value: 0.4, label: "Strong" } };

const state = {
  gd: null,
  saves: [],
  saveId: null,
  source: null, // "live" | "file"
  fileName: "",
  mtimeMs: 0,
  characters: [],
  charIndex: 0,
  newKeys: new Set(),
  tab: store.get("tab", "relics"),
  browse: { search: "", filter: store.get("browse.filter", 0), sell: false, newOnly: false },
  combo: {
    nightfarer: store.get("combo.nightfarer", 0),
    build: null, // working copy of the selected build; every edit is saved right away
    ui: {}, // { creating | renaming | duplicating | confirmDelete }
    result: null,
    running: false,
    error: null,
  },
  liveConnected: false,
};

const character = () => state.characters[state.charIndex];
const effectsCache = new WeakMap();
const availableEffects = (c) => {
  if (!effectsCache.has(c)) effectsCache.set(c, computeAvailableEffects(c));
  return effectsCache.get(c);
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function boot() {
  try {
    // Optional overlay with names for effects only the More Map Variations mod has
    const mmv = await fetch("data/mmv-names.json").then((r) => (r.ok ? r.json() : null), () => null);
    const stacking = await fetch("data/stacking.json").then((r) => (r.ok ? r.json() : null), () => null);
    state.gd = createGameData(await (await fetch("data/game-data.json")).json(), mmv, stacking);
    state.presets = await fetch("data/presets.json").then((r) => (r.ok ? r.json() : []), () => []);
  } catch (err) {
    return showFatal(`Could not load game data (data/game-data.json): ${err.message}`);
  }
  migrateOldSettings();
  wireGlobalEvents();
  try {
    const res = await fetch("api/saves", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const { saves, root } = await res.json();
    state.saves = saves;
    state.saveRoot = root;
  } catch {
    state.saves = []; // served without server.mjs: file picker only
    state.noServer = true;
  }
  if (state.saves.length > 0) {
    await loadLive(state.saves[0].id);
    connectEvents();
  } else {
    renderWelcome();
  }
  setInterval(renderStatus, 30000);
}

async function loadLive(id, { announce = false } = {}) {
  const save = state.saves.find((s) => s.id === id);
  if (!save) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`api/saves/${encodeURIComponent(id)}/file`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      await applySave(buf, { source: "live", saveId: id, fileName: save.path.split(/[\/]/).pop(), mtimeMs: Number(res.headers.get("X-Save-Mtime")) || Date.now(), announce });
      return;
    } catch (err) {
      // The game may be mid-write; give it a moment and retry.
      if (attempt === 3) {
        if (state.characters.length) toast(`Couldn't reload the save: ${err.message}`);
        else showFatal(`Couldn't read your save: ${err.message}`);
      } else {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }
}

async function loadFile(file) {
  try {
    await applySave(await file.arrayBuffer(), { source: "file", saveId: `file:${file.name}`, fileName: file.name, mtimeMs: file.lastModified });
  } catch (err) {
    toast(err instanceof SaveParseError ? err.message : `Couldn't read ${file.name}: ${err.message}`, 7000);
  }
}

async function applySave(buffer, { source, saveId, fileName, mtimeMs, announce }) {
  const parsed = await parseSave(buffer);
  const characters = parsed.slots.filter((s) => s.name).map((s) => buildCharacter(s, state.gd));
  if (characters.length === 0) throw new SaveParseError("No characters found in this save.");

  const prevChar = character();
  const sameSave = state.saveId === saveId;
  state.source = source;
  state.saveId = saveId;
  state.fileName = fileName;
  state.mtimeMs = mtimeMs;
  state.characters = characters;
  const remembered = store.get(`char:${saveId}`, null);
  const keep = sameSave && prevChar ? characters.findIndex((c) => c.index === prevChar.index) : characters.findIndex((c) => c.index === remembered);
  state.charIndex = keep >= 0 ? keep : 0;

  const before = sameSave && prevChar ? new Set(prevChar.relics.map((r) => r.key)) : null;
  updateNewRelics();
  if (!before) {
    banner("Relics Retrieved");
    toast(`Welcome to Relic Vault. ${character().name} carries ${character().relics.length} relics.`);
  }
  if (announce && before) {
    const added = character().relics.filter((r) => !before.has(r.key)).length;
    const now = new Set(character().relics.map((r) => r.key));
    const removed = [...before].filter((k) => !now.has(k)).length;
    // The game saves often mid-run; only speak up when the relic list actually changed
    if (added || removed) toast(`Save updated — ${added} new relic${added === 1 ? "" : "s"}${removed ? `, ${removed} sold or removed` : ""}`);
    if (added) banner(added === 1 ? "Relic Acquired" : `${added} Relics Acquired`);
  }
  renderAll();
}

/** "NEW" = relics not in the baseline the user last marked as seen for this save + character. */
function updateNewRelics() {
  const c = character();
  const key = `seen2:${state.saveId}:${c.index}`;
  const baseline = store.get(key, null);
  if (baseline === null) {
    store.set(key, c.relics.map((r) => r.key));
    state.newKeys = new Set();
  } else {
    const seen = new Set(baseline);
    state.newKeys = new Set(c.relics.filter((r) => !seen.has(r.key)).map((r) => r.key));
  }
  if (state.newKeys.size === 0) state.browse.newOnly = false;
}

function markAllSeen() {
  const c = character();
  store.set(`seen2:${state.saveId}:${c.index}`, c.relics.map((r) => r.key));
  state.newKeys = new Set();
  state.browse.newOnly = false;
  renderBrowse();
}

function connectEvents() {
  const es = new EventSource("api/events");
  let timer;
  es.onopen = () => { state.liveConnected = true; renderStatus(); };
  es.onerror = () => { state.liveConnected = false; renderStatus(); };
  es.addEventListener("save-changed", (ev) => {
    const { id } = JSON.parse(ev.data);
    if (state.source !== "live" || id !== state.saveId) return;
    // Let the game finish writing before reading.
    clearTimeout(timer);
    timer = setTimeout(() => loadLive(id, { announce: true }), 1500);
  });
}

// ---------------------------------------------------------------------------
// Rendering: shell
// ---------------------------------------------------------------------------
function showFatal(message) {
  $("#app").innerHTML = `<div class="error-box">${esc(message)}</div>`;
}

function renderWelcome() {
  $("#tabs").hidden = true;
  $("#character-picker").hidden = true;
  renderStatus();
  const where = state.saveRoot ? `<code>${esc(state.saveRoot)}\\&lt;SteamID&gt;\\NR0000.sl2</code>` : "<code>%APPDATA%\\Nightreign\\&lt;SteamID&gt;\\NR0000.sl2</code>";
  $("#app").innerHTML = `<section class="welcome">
    <p class="flourish">✦ ✦ ✦</p>
    <p class="lede">${state.noServer ? "Open your save file to get started." : "No Nightreign save was found automatically."} Your save lives at ${where}.</p>
    <div class="actions">
      <label class="btn btn-primary"><input type="file" accept=".sl2,.co2,.bak" hidden data-file /> Open save file…</label>
    </div>
    <p class="muted">…or drag and drop it anywhere on this page.</p>
    ${safetyNote()}
  </section>`;
}

const safetyNote = () => `<div class="safety stone">
  <h2>✓ Ban-safe by design</h2>
  <ul>
    <li>Reads a <b>copy of the save bytes</b> only. It never writes to, locks, or modifies your save.</li>
    <li>Never touches the game process, its memory or files, so Easy Anti-Cheat has nothing to see.</li>
    <li>Runs entirely on this PC (localhost). No uploads, no analytics.</li>
  </ul>
</div>`;

function renderAll() {
  $("#tabs").hidden = false;
  renderCharacterPicker();
  renderStatus();
  renderTabs();
  if (state.tab === "combo") {
    renderCombo();
    scheduleSearch(); // relics may have changed (live refresh) or the page was just restored
  } else {
    renderBrowse();
  }
}

function renderCharacterPicker() {
  const el = $("#character-picker");
  el.hidden = false;
  el.innerHTML = state.characters.length > 1
    ? `<select aria-label="Character">${state.characters.map((c, i) => `<option value="${i}" ${i === state.charIndex ? "selected" : ""}>${esc(c.name)} — ${c.relics.length} relics</option>`).join("")}</select>`
    : `<span class="muted">Character:</span> <b>${esc(character().name)}</b> <span class="muted">· ${character().relics.length} relics</span>`;
}

function renderStatus() {
  const el = $("#save-status");
  if (!state.source) {
    el.className = "save-status";
    el.innerHTML = "";
    return;
  }
  if (state.source === "live") {
    el.className = `save-status ${state.liveConnected ? "live" : ""}`;
    const picker = state.saves.length > 1
      ? `<select data-save-select aria-label="Save file">${state.saves.map((s) => `<option value="${esc(s.id)}" ${s.id === state.saveId ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>`
      : "";
    el.innerHTML = `${picker}<span class="dot"></span><span title="Auto-refreshes when the game saves">${state.liveConnected ? "Live" : "Reconnecting…"} · saved ${timeAgo(state.mtimeMs)}</span>`;
  } else {
    el.className = "save-status file";
    el.innerHTML = `<span class="dot"></span><span>${esc(state.fileName)}</span>${state.saves.length ? ` <button class="btn btn-ghost" data-action="back-live" style="padding:2px 8px">Back to live save</button>` : ""}`;
  }
}

function renderTabs() {
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
}

// ---------------------------------------------------------------------------
// Relics tab
// ---------------------------------------------------------------------------
function browseMatches() {
  const { search, filter, sell, newOnly } = state.browse;
  const f = COLOR_FILTERS[filter] ?? COLOR_FILTERS[0];
  const term = search.trim().toLowerCase();
  return character().relics.filter((r) => {
    if (sell && !(r.redundant && r.sellable)) return false;
    if (newOnly && !state.newKeys.has(r.key)) return false;
    if (f.type === ItemType.DeepRelic && !r.isDeep) return false;
    if (f.type !== undefined && f.type !== ItemType.DeepRelic && r.isDeep) return false;
    if (f.color !== Color.Any && r.color !== f.color) return false;
    return !term || r.searchText.includes(term);
  });
}

function renderBrowse() {
  const c = character();
  const unknown = state.gd.unknownItems.size + state.gd.unknownEffects.size;
  $("#app").innerHTML = `
    <div class="toolbar">
      <div id="browse-search"></div>
      <div class="segmented" role="group" aria-label="Color filter">
        ${COLOR_FILTERS.map((f, i) => `${i === 5 ? '<span class="seg-label">Deep</span>' : ""}<button type="button" data-filter="${i}" aria-pressed="${i === state.browse.filter}" title="${f.color === Color.Any ? "All relics" : `${f.type === ItemType.DeepRelic ? "Deep" : "Normal"} ${["", "red", "blue", "yellow", "green"][f.color]} relics`}">${colorChip(f.color, f.type === ItemType.DeepRelic)}</button>`).join("")}
      </div>
      <label class="toggle" title="Duplicates and relics outclassed by another relic of the same color"><input type="checkbox" data-toggle="sell" ${state.browse.sell ? "checked" : ""}/> Sell candidates</label>
      ${state.newKeys.size ? `<label class="toggle"><input type="checkbox" data-toggle="newOnly" ${state.browse.newOnly ? "checked" : ""}/> New only (${state.newKeys.size})</label><button class="btn btn-ghost" data-action="mark-seen">Mark all seen</button>` : ""}
    </div>
    <div class="summary" id="browse-summary"></div>
    ${unknown ? `<div class="toolbar"><div class="warn-box">${state.gd.unknownItems.size} relic type(s) and ${state.gd.unknownEffects.size} effect(s) in your save aren't in the data tables yet (newer game patch?). Run <code>node scripts/update-data.mjs</code> to refresh.</div></div>` : ""}
    ${c.warning ? `<div class="toolbar"><div class="warn-box">${esc(c.warning)}</div></div>` : ""}
    <div class="content" id="browse-grid"></div>`;

  const picker = effectPicker($("#browse-search"), {
    placeholder: "Search relics by name or effect…",
    getOptions: () => availableEffects(c),
    onInput: (text) => {
      state.browse.search = text;
      scheduleGrid();
    },
  });
  picker.setValue(state.browse.search);
  renderBrowseGrid();
}

let gridTimer;
function scheduleGrid() {
  clearTimeout(gridTimer);
  gridTimer = setTimeout(renderBrowseGrid, 60);
}

function renderBrowseGrid() {
  const c = character();
  const matches = browseMatches();
  const f = COLOR_FILTERS[state.browse.filter] ?? COLOR_FILTERS[0];
  const byColor = f.color !== Color.Any;
  const search = state.browse.search.trim();
  const normal = matches.filter((r) => !r.isDeep);
  const deep = matches.filter((r) => r.isDeep);
  const total = c.relics.length;
  $("#browse-summary").innerHTML = matches.length === total
    ? `Showing all <b>${normal.length}</b> relics and <b>${deep.length}</b> deep relics on <b>${esc(c.name)}</b>, newest first (in-game "Order Found")`
    : `Showing <b>${normal.length}</b> matching relics and <b>${deep.length}</b> matching deep relics out of ${total} on <b>${esc(c.name)}</b>`;

  const section = (title, list, hint) => list.length === 0 ? "" : `
    <h2 class="group-title">${title} <small>${list.length} · ${hint}</small></h2>
    <div class="grid">${list.map((r) => relicCard(r, { search, byColor, isNew: state.newKeys.has(r.key) })).join("")}</div>`;
  const hint = byColor ? `rows/columns match the in-game ${["", "red", "blue", "yellow", "green"][f.color]} filter` : "rows of 8, like the in-game grid";
  $("#browse-grid").innerHTML = matches.length === 0
    ? `<div class="empty"><strong>No relics found</strong><span>${state.browse.sell ? "Nothing to sell with these filters. Nice." : "Try a different search or filter."}</span></div>`
    : section("Relics", normal, hint) + section("Deep Relics", deep, hint);
}

function openCompare(uid) {
  const relic = character().relics.find((r) => r.uid === uid);
  if (!relic?.redundant) return;
  const f = COLOR_FILTERS[state.browse.filter] ?? COLOR_FILTERS[0];
  const byColor = f.color !== Color.Any;
  $("#compare-reason").textContent = relic.redundant.outclassed
    ? "This relic is outclassed: the relic on the right has every one of its effects at an equal or higher level, plus more."
    : "This relic is a duplicate: the relic on the right has the same effects at the same level.";
  $("#compare-body").innerHTML = `
    <div><div class="label">Sell this one</div>${relicCard(relic, { byColor, showSell: false })}</div>
    <div><div class="label">Keep this one</div>${relicCard(relic.redundant.relic, { byColor, showSell: false })}</div>`;
  $("#compare-dialog").showModal();
}

// ---------------------------------------------------------------------------
// Combo Finder tab: Nightfarer -> build -> wanted and avoided effects. Every vessel of the
// Nightfarer is searched.
// ---------------------------------------------------------------------------
const nightfarer = () => state.gd.nightfarers.find((n) => n.id === state.combo.nightfarer) ?? state.gd.nightfarers[0];
const orBetter = (e) => e.stacks && !e.maxLevel;
const effectLabel = (e) => `${e.name}${orBetter(e) ? " (or better)" : ""}`;
const RANKS = Array.from({ length: MAX_RANK }, (_, i) => i + 1);
const rankName = (r) => (r === 1 ? "1 · highest" : rankLabel(r));

/**
 * Every effect this Nightfarer can use: their own effects first, then A-Z with MMV-only ones last. Effects in none of
 * the character's relics are listed too (dimmed by the picker). MMV-only effects are offered
 * on modded saves, or when a relic has one. Effects already in the build are left out.
 */
function selectableEffects() {
  const nf = state.combo.nightfarer;
  const have = new Set(availableEffects(character()));
  const modded = /\.co2$/i.test(state.fileName ?? "");
  const b = state.combo.build;
  const used = new Set(b ? [...b.wanted, ...b.avoid].map((e) => e.effectKey) : []);
  return state.gd.effectsByKey
    .filter((e) =>
      e && !e.unknown && !used.has(e.key) &&
      (!e.mmv || modded || have.has(e)) &&
      (e.nightfarer === undefined || e.nightfarer === nf || ALWAYS_SELECTABLE.has(e.slug)))
    .sort((a, b) => (b.nightfarer === nf) - (a.nightfarer === nf) || Boolean(a.mmv) - Boolean(b.mmv) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
/** Wanted-effect choices: one entry per strength family (its weakest level), none already in the build. */
function wantOptions() {
  const taken = new Set((state.combo.build?.wanted ?? []).map((w) => state.gd.effectByKey(w.effectKey)).filter((e) => familyOf(state.gd, e)).map((e) => e.group));
  const out = [];
  for (const e of selectableEffects()) {
    if (e.type === EffectType.Debuff) continue;
    const family = familyOf(state.gd, e);
    if (!family) { out.push(e); continue; }
    if (taken.has(e.group)) continue;
    taken.add(e.group);
    out.push(family[0]);
  }
  return out;
}
/** Picker label: families by their plain name, since strength is chosen on the card. */
const wantLabel = (e) => (familyOf(state.gd, e) ? familyName(state.gd, e) : effectLabel(e));
/** This effect or (for a family) any stronger level, as the search counts it. */
const atLeast = (e) => (orBetterFamily(state.gd, e) ? familyOf(state.gd, e).filter((m) => m === e || m.level >= e.level) : [e]);
const owned = (e) => atLeast(e).some(inRelics);
// Curses first, then anything else a build might want to keep out
const avoidOptions = () => {
  const all = selectableEffects();
  return [...all.filter((e) => e.type === EffectType.Debuff), ...all.filter((e) => e.type !== EffectType.Debuff)];
};
const inRelics = (e) => availableEffects(character()).includes(e);
const notInRelicsHint = (e) => (owned(e) ? "" : "not in your relics");

// ---------------------------------------------------------------------------
// Stacking, as the search counts it (data/stacking.json corrects the game data): every copy of an
// effect that stacks counts; an effect that doesn't stack counts once per different strength.
// ---------------------------------------------------------------------------
/** Does relic effect `e` count toward the wanted `effect` (itself, or a stronger level of its family)? */
const countsToward = (effect, e) => e === effect || (!perStrength(state.gd, effect) && (e.stacks || familyOf(state.gd, effect)) && isSameGroupAndEqualOrBetter(effect, e));

/** How many times `effects` (from one combo) count toward `effect`. */
function stackCount(effect, effects) {
  let n = 0;
  const once = new Set();
  for (const e of effects) {
    if (!countsToward(effect, e)) continue;
    if (e.stacks) n++;
    else if (!once.has(e)) { once.add(e); n++; }
  }
  return n;
}

/** "stacks", "only different strengths stack", or "doesn't stack", for the strengths that count. */
function stackRule(effect) {
  const levels = atLeast(effect);
  const stacking = levels.filter((e) => e.stacks).length;
  if (stacking === levels.length) return { tag: "stacks", count: true, title: "Every copy adds up" };
  if (stacking === 0) {
    return levels.length > 1
      ? { tag: "strengths stack", count: true, title: "A second copy of the same strength does nothing, but different strengths add up" }
      : { tag: "doesn't stack", count: false, title: "A second copy does nothing" };
  }
  return { tag: "partly stacks", count: true, title: `Copies of ${levels.filter((e) => e.stacks).map(strengthTick).join(", ")} add up; ${levels.filter((e) => !e.stacks).map(strengthTick).join(", ")} count once each` };
}

/** Most counts of `effect` one vessel could reach with this character's relics (greedy per slot). */
function maxStacksFor(effect) {
  if (!stackRule(effect).count) return 1;
  const c = character();
  const deepOff = !state.combo.build?.includeDeep;
  const nf = state.combo.nightfarer;
  const usable = (r) => r.effects.flat().filter((e) => (e.nightfarer === undefined || e.nightfarer === nf) && countsToward(effect, e));
  const normal = c.relics.filter((r) => !r.isDeep && usable(r).length);
  const deep = c.relics.filter((r) => r.isDeep && usable(r).length);
  let best = 0;
  for (const vessel of nightfarer().vessels) {
    const picked = [];
    vessel.slots.forEach((slot, i) => {
      if (i >= 3 && deepOff) return;
      const pool = (i >= 3 ? deep : normal).filter((r) => (slot === Color.Any || r.color === slot) && !picked.includes(r));
      const now = stackCount(effect, picked.flatMap(usable));
      let gain = 0, pick;
      for (const r of pool) {
        const g = stackCount(effect, [...picked, r].flatMap(usable)) - now;
        if (g > gain) { gain = g; pick = r; }
      }
      if (pick) picked.push(pick);
    });
    best = Math.max(best, stackCount(effect, picked.flatMap(usable)));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Builds. data/presets.json builds are listed alongside the ones made here. The server never
// writes files, so editing a file build saves a copy in this browser under the same id, and
// deleting one hides it.
// ---------------------------------------------------------------------------
const userBuilds = () => store.get("builds", []);
const hiddenPresets = () => store.get("builds.hidden", []);

function storedBuilds() {
  const mine = userBuilds();
  const byId = new Map(mine.map((b) => [b.id, b]));
  const hidden = new Set(hiddenPresets());
  const presets = (state.presets ?? []).filter((b) => !hidden.has(b.id));
  const presetIds = new Set((state.presets ?? []).map((b) => b.id));
  return [...presets.map((b) => byId.get(b.id) ?? b), ...mine.filter((b) => !presetIds.has(b.id))];
}
const buildsFor = (nf) => storedBuilds().filter((b) => b.nightfarer === nf);
const newBuildId = () => `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function selectBuild(id, { quiet = false } = {}) {
  const stored = storedBuilds().find((b) => b.id === id);
  if (!stored) return;
  const { build, missing } = fromStored(state.gd, stored);
  state.combo.build = build;
  state.combo.nightfarer = build.nightfarer;
  state.combo.ui = {};
  state.combo.result = null;
  store.set("combo.active", { ...store.get("combo.active", {}), [build.nightfarer]: id });
  saveNightfarer();
  if (quiet) return;
  const absent = build.wanted.filter((e) => !owned(state.gd.effectByKey(e.effectKey))).length;
  const notes = [
    absent && `${absent} wanted effect${absent === 1 ? " isn't" : "s aren't"} on ${character().name}'s relics`,
    missing && `${missing} unknown effect(s) skipped`,
  ].filter(Boolean);
  if (notes.length) toast(`${build.name}: ${notes.join(", ")}`);
}

/** Makes sure the working build belongs to the selected Nightfarer (last used, else their first). */
function ensureBuild() {
  const nf = state.combo.nightfarer;
  const b = state.combo.build;
  const list = buildsFor(nf);
  if (b && b.nightfarer === nf && list.some((s) => s.id === b.id)) return;
  const remembered = store.get("combo.active", {})[nf];
  const pick = list.find((s) => s.id === remembered) ?? list[0];
  state.combo.build = null;
  if (pick) selectBuild(pick.id, { quiet: true });
}

function persistBuild() {
  const b = state.combo.build;
  if (!b) return;
  const stored = toStored(state.gd, b);
  const mine = userBuilds();
  const i = mine.findIndex((x) => x.id === b.id);
  if (i >= 0) mine[i] = stored; else mine.push(stored);
  store.set("builds", mine);
}

function saveNightfarer() {
  store.set("combo.nightfarer", state.combo.nightfarer);
}

/** One-time move of the old per-Nightfarer working setup into a "Recovered build" when it isn't already a build. */
function migrateOldSettings() {
  if (store.get("builds.migrated", false)) return;
  const old = store.get("combo.settings", {});
  const known = new Set(storedBuilds().map((s) => signature(fromStored(state.gd, s).build)));
  const mine = userBuilds();
  for (const [nf, s] of Object.entries(old ?? {})) {
    if (!state.gd.nightfarers.some((n) => n.id === Number(nf)) || !s?.selectedEffects?.length) continue;
    const effects = s.selectedEffects
      .map((e) => ({ slug: state.gd.effectByKey(e.effectKey)?.slug, min: e.minStacks, max: e.maxStacks, ...(e.rank !== undefined ? { rank: e.rank } : { weight: e.weight }) }))
      .filter((e) => e.slug);
    const { build } = fromStored(state.gd, { id: newBuildId(), name: "Recovered build", nightfarer: Number(nf), excludeDeepEffects: s.excludeDeepEffects, cursePenalty: s.cursePenalty, effects });
    if (build.wanted.length + build.avoid.length === 0 || known.has(signature(build))) continue;
    mine.push(toStored(state.gd, build));
  }
  store.set("builds", mine);
  store.set("builds.migrated", true);
}

function createBuild(name, from = null) {
  const id = newBuildId();
  const build = from ? { ...structuredClone(from), id, name } : emptyBuild(id, name, state.combo.nightfarer);
  state.combo.build = build;
  state.combo.ui = {};
  state.combo.result = null;
  store.set("combo.active", { ...store.get("combo.active", {}), [build.nightfarer]: id });
  comboChanged();
  if (!from) $("#want-picker input")?.focus();
}

function deleteBuild() {
  const b = state.combo.build;
  if (!b) return;
  store.set("builds", userBuilds().filter((x) => x.id !== b.id));
  if ((state.presets ?? []).some((x) => x.id === b.id)) store.set("builds.hidden", [...hiddenPresets(), b.id]);
  toast(`Deleted "${b.name}"`);
  state.combo.build = null;
  state.combo.ui = {};
  state.combo.result = null;
  renderCombo();
  scheduleSearch();
}

function confirmName() {
  const input = $("[data-build-name]");
  const name = input?.value.trim();
  if (!name) return input?.focus();
  const ui = state.combo.ui;
  if (ui.renaming) {
    state.combo.build.name = name;
    state.combo.ui = {};
    comboChanged({ search: false });
  } else {
    createBuild(name, ui.duplicating ? state.combo.build : null);
  }
}

function startNaming(mode) {
  state.combo.ui = { [mode]: true };
  renderCombo();
  const input = $("[data-build-name]");
  input?.focus();
  input?.select();
}

// ---------------------------------------------------------------------------
// Editing effects (every change is saved to the build right away)
// ---------------------------------------------------------------------------
function addWanted(effect) {
  const b = state.combo.build;
  if (!b || b.wanted.some((e) => e.effectKey === effect.key)) return;
  // Same rules as upstream: a stackable effect replaces other levels of its group,
  // and only one "starting armament" bonus of each kind can apply.
  b.wanted = b.wanted.filter((entry) => {
    const e = state.gd.effectByKey(entry.effectKey);
    if (isSameGroup(e, effect) && e.stacks === true && effect.stacks === true) return false;
    if (e.startingBonus !== undefined && e.startingBonus === effect.startingBonus) return false;
    return true;
  });
  b.wanted.push(newWanted(state.gd, effect));
  comboChanged();
  $("#want-picker input")?.focus(); // keep typing to add more
}

function addAvoid(effect) {
  const b = state.combo.build;
  if (!b || b.avoid.some((e) => e.effectKey === effect.key)) return;
  b.avoid.push(newAvoid(effect));
  comboChanged();
  $("#avoid-picker input")?.focus();
}

function comboChanged({ rerender = true, search = true } = {}) {
  persistBuild();
  saveNightfarer();
  if (rerender) renderCombo();
  if (search) scheduleSearch();
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runComboSearch, 150);
}

async function runComboSearch() {
  const b = state.combo.build;
  if (!b || b.wanted.length === 0) {
    cancelSearch();
    Object.assign(state.combo, { result: null, running: false, error: null });
    return renderComboResults();
  }
  const selected = b.wanted.map((e) => state.gd.effectByKey(e.effectKey));
  const vessels = nightfarer().vessels;
  const c = character();
  const built = buildSearch(state.gd, {
    nightfarer: b.nightfarer,
    selectedEffects: selected,
    relics: c.relics.filter((r) => r.item.type === ItemType.Relic || r.item.type === ItemType.UniqueRelic),
    deepRelics: b.includeDeep ? c.relics.filter((r) => r.item.type === ItemType.DeepRelic) : [],
    enabledVessels: vessels,
    selectedEntries: [
      ...b.wanted.map((e) => ({ effectKey: e.effectKey, minStacks: e.minStacks, maxStacks: e.maxStacks, weight: wantedWeight(e), orBetter: orBetterFamily(state.gd, state.gd.effectByKey(e.effectKey)) })),
      ...b.avoid.filter((a) => a.block).map((a) => ({ effectKey: a.effectKey, minStacks: 0, maxStacks: 0 })),
    ],
    avoidEntries: b.avoid.filter((a) => !a.block).map((a) => ({ effectKey: a.effectKey, penalty: avoidPenaltyForRank(a.rank) })),
    cursePenalty: CURSE_PENALTY[b.cursePenalty]?.value ?? 0,
  });
  state.combo.running = true;
  state.combo.error = null;
  renderComboResults();
  try {
    const res = await searchCombos(built.input);
    state.combo.result = {
      ms: res.ms,
      checked: res.checked,
      workerError: res.mainThread ? res.workerError : null,
      highlighted: selected,
      entries: b.wanted.map((e) => ({ ...e, effect: state.gd.effectByKey(e.effectKey) })),
      avoided: b.avoid.map((a) => ({ ...a, effect: state.gd.effectByKey(a.effectKey) })),
      excludeDeep: !b.includeDeep,
      combos: res.combinations.map((combo) => ({
        vessel: vessels[combo.vessel],
        points: combo.points,
        relics: combo.idx6.map((ix, slot) => (ix < 0 ? null : (slot < 3 ? built.relics : built.deepRelics)[ix])),
      })),
    };
    state.combo.running = false;
    renderComboResults();
  } catch (err) {
    if (err instanceof SearchCancelled) return;
    Object.assign(state.combo, { running: false, error: err.message, result: null });
    renderComboResults();
  }
}

// ---------------------------------------------------------------------------
// Combo Finder rendering
// ---------------------------------------------------------------------------
function renderCombo() {
  ensureBuild();
  const nf = nightfarer();
  const b = state.combo.build;
  // Re-rendering replaces the columns; keep where each one was scrolled (the effects column only
  // while it still shows the same build) so removing or changing an effect doesn't jump to the top.
  const view = `${nf.id}:${b?.id ?? ""}`;
  const keep = [...document.querySelectorAll(".combo > section:not(.results)")].map((el, i) => (i < 2 || state.combo.view === view ? el.scrollTop : 0));
  const pageY = window.scrollY;
  state.combo.view = view;
  $("#app").innerHTML = `<div class="combo">
    <section>
      <h3>I · Nightfarer</h3>
      <div class="nf-list">${state.gd.nightfarers.map((n) => {
        const count = buildsFor(n.id).length;
        return `<label><input type="radio" name="nf" value="${n.id}" ${n.id === nf.id ? "checked" : ""}/> ${esc(n.name)}${count ? `<span class="nf-count" title="${count} build${count === 1 ? "" : "s"}">${count}</span>` : ""}</label>`;
      }).join("")}</div>
    </section>
    <section class="build-col">
      <h3>II · Build</h3>
      ${buildColumn(nf, b)}
    </section>
    <section class="editor">
      <h3>III · Effects</h3>
      ${b ? effectsEditor(b) : `<div class="empty small"><strong>No build selected</strong><span>Create a ${esc(nf.name)} build to choose effects.</span></div>`}
    </section>
    <section class="results" id="combo-results"></section>
  </div>`;

  if (b) {
    effectPicker($("#want-picker"), { placeholder: "Add an effect you want…", getOptions: wantOptions, label: wantLabel, hint: notInRelicsHint, clearOnPick: true, onPick: addWanted });
    effectPicker($("#avoid-picker"), { placeholder: "Add a curse to avoid…", getOptions: avoidOptions, hint: notInRelicsHint, clearOnPick: true, onPick: addAvoid });
  }
  renderComboResults();
  document.querySelectorAll(".combo > section:not(.results)").forEach((el, i) => { el.scrollTop = keep[i] ?? 0; });
  if (keep.length) window.scrollTo(0, pageY); // narrow screens scroll the page instead of the columns
}

const nameForm = (value, label) => `<div class="name-row">
  <input class="text-input plain" data-build-name value="${esc(value)}" placeholder="Build name" maxlength="80" />
  <button class="btn btn-primary" data-build="confirm-name">${label}</button>
  <button class="btn btn-ghost" data-build="cancel">Cancel</button>
</div>`;

function buildColumn(nf, b) {
  const ui = state.combo.ui ?? {};
  const list = buildsFor(nf.id);
  const top = ui.creating
    ? nameForm("", "Create")
    : `<button type="button" class="btn new-build" data-build="new">+ New ${esc(nf.name)} build</button>`;
  const items = list.map((s) => {
    const active = b?.id === s.id;
    if (active && ui.renaming) return `<div class="build-item active">${nameForm(b.name, "Rename")}</div>`;
    const meta = summary(active ? b : fromStored(state.gd, s).build);
    return `<button type="button" class="build-item${active ? " active" : ""}" data-build-pick="${esc(s.id)}" aria-pressed="${active}">
      <span class="bname">${esc(active ? b.name : s.name)}</span><span class="bmeta">${meta}</span>
    </button>`;
  }).join("");
  const dup = ui.duplicating ? nameForm(`${b.name} (copy)`, "Duplicate") : "";
  const actions = b && !ui.renaming && !ui.duplicating ? `<div class="build-actions">
      <button class="btn btn-ghost" data-build="rename">Rename</button>
      <button class="btn btn-ghost" data-build="duplicate">Duplicate</button>
      ${ui.confirmDelete
        ? `<button class="btn btn-danger" data-build="confirm-delete">Delete it</button><button class="btn btn-ghost" data-build="cancel">Keep</button>`
        : `<button class="btn btn-ghost" data-build="delete">Delete</button>`}
    </div>` : "";
  const options = b ? `<div class="build-options">
      <label class="switch"><input type="checkbox" data-combo="include-deep" ${b.includeDeep ? "checked" : ""}/> Use deep relic slots</label>
      <p class="muted fine">Searches all ${nf.vessels.length} of ${esc(nf.name)}'s vessels.</p>
    </div>` : "";
  return `${top}
    <div class="build-list">${items || `<p class="muted fine">No ${esc(nf.name)} builds yet.</p>`}</div>
    ${dup}${actions}${options}`;
}

function effectsEditor(b) {
  const nameOf = (k) => state.gd.effectByKey(k).name;
  const order = (x, y) =>
    (y.minStacks > 0) - (x.minStacks > 0) || (x.minStacks > 0 ? 0 : x.rank - y.rank) || nameOf(x.effectKey).localeCompare(nameOf(y.effectKey));
  // Strengths of a per-strength family share one card, placed by its most important strength
  const cards = [];
  const familyCards = new Map();
  for (const entry of [...b.wanted].sort(order)) {
    const e = state.gd.effectByKey(entry.effectKey);
    if (!perStrength(state.gd, e)) { cards.push(wantedRow(entry)); continue; }
    if (familyCards.has(e.group)) continue;
    familyCards.set(e.group, true);
    cards.push(familyCard(e));
  }
  const avoid = [...b.avoid].sort((x, y) =>
    y.block - x.block || (x.block ? 0 : x.rank - y.rank) || nameOf(x.effectKey).localeCompare(nameOf(y.effectKey)));
  const required = b.wanted.filter((e) => e.minStacks > 0).length;
  const blocked = b.avoid.filter((a) => a.block).length;
  return `
    <div class="ed-block">
      <h4 class="ed-title">Wanted <small>${b.wanted.length ? `${required} required · ${b.wanted.length - required} ranked` : "none yet"}</small></h4>
      <div id="want-picker"></div>
      ${b.wanted.length
        ? `<ul class="picked">${cards.join("")}</ul>`
        : `<p class="muted fine ed-help">Add the effects this build is after. Must-haves are <b>Required</b>; the rest are ranked from 1 (most important) to 12.</p>`}
    </div>
    <div class="ed-block avoid-block">
      <h4 class="ed-title">Avoid <small>${b.avoid.length ? `${blocked} blocked · ${b.avoid.length - blocked} ranked` : "none yet"}</small></h4>
      <div id="avoid-picker"></div>
      ${b.avoid.length
        ? `<ul class="avoid-list">${avoid.map(avoidRow).join("")}</ul>`
        : `<p class="muted fine ed-help"><b>Block</b> a curse to rule out every relic that carries it, or give it a priority so it only counts against a combo.</p>`}
      <div class="opt-row" title="How much curses that are not on this list count against a combo">
        <span>Other curses</span>
        <div class="segmented small">${Object.entries(CURSE_PENALTY).map(([k, v]) => `<button type="button" data-curse="${k}" aria-pressed="${b.cursePenalty === k}">${v.label}</button>`).join("")}</div>
      </div>
      ${b.includeDeep ? "" : `<p class="muted fine">Deep relic slots are off, so no curses can show up.</p>`}
    </div>`;
}

function priorityControl(entry) {
  const required = entry.minStacks > 0;
  const options = [`<option value="req" ${required ? "selected" : ""}>Required</option>`,
    ...RANKS.map((r) => `<option value="${r}" ${!required && r === entry.rank ? "selected" : ""}>${rankName(r)}</option>`)].join("");
  const lit = required ? MAX_RANK : MAX_RANK + 1 - entry.rank;
  const pips = Array.from({ length: MAX_RANK }, (_, i) => `<i class="${i < lit ? "on" : ""}"></i>`).join("");
  const title = required ? "Every combo must include this" : `Scores ×${weightForRank(entry.rank)} (1 is ×3 … 12 is ×0.25)`;
  return `<div class="opt-row prio">
    <span>Priority</span>
    <select class="rank-select${required ? " is-required" : ""}" data-want-rank aria-label="Priority: Required, or 1 (highest) to 12">${options}</select>
    <span class="pips${required ? " req" : ""}" title="${title}">${pips}</span>
    ${stackTag(state.gd.effectByKey(entry.effectKey))}
  </div>`;
}

const RANK_OPTIONS = (selected) => RANKS.map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${rankName(r)}</option>`).join("");

/** One card for a family whose strengths each add up but never stack with themselves: a priority per strength. */
function familyCard(effect) {
  const family = familyOf(state.gd, effect);
  const b = state.combo.build;
  const name = familyName(state.gd, effect);
  const anyRequired = family.some((m) => b.wanted.some((w) => w.effectKey === m.key && w.minStacks > 0));
  const rows = family.map((m) => {
    const entry = b.wanted.find((w) => w.effectKey === m.key);
    const value = !entry ? "" : entry.minStacks > 0 ? "req" : String(entry.rank);
    const lit = !entry ? 0 : entry.minStacks > 0 ? MAX_RANK : MAX_RANK + 1 - entry.rank;
    const pips = Array.from({ length: MAX_RANK }, (_, i) => `<i class="${i < lit ? "on" : ""}"></i>`).join("");
    return `<div class="level-row${entry ? "" : " off"}${value === "req" ? " required" : ""}" data-level="${m.key}">
      <span class="tick${inRelics(m) ? " own" : ""}" title="${esc(m.name)}${inRelics(m) ? "" : " (not on your relics)"}">${strengthTick(m)}</span>
      <select class="rank-select${value === "req" ? " is-required" : ""}" data-level-rank aria-label="Priority for ${esc(m.name)}">
        <option value="" ${value === "" ? "selected" : ""}>—</option>
        <option value="req" ${value === "req" ? "selected" : ""}>Required</option>
        ${RANK_OPTIONS(entry && value !== "req" ? entry.rank : -1)}
      </select>
      <span class="pips${value === "req" ? " req" : ""}">${pips}</span>
    </div>`;
  }).join("");
  const missing = family.some(inRelics) ? "" : `<span class="note" title="None of ${esc(character().name)}'s relics have this">not owned</span>`;
  return `<li class="family${anyRequired ? " required" : ""}" data-family="${effect.group}">
    <div class="row"><span class="name">${esc(name)}</span>${missing}<button class="icon-btn" data-remove-family="${effect.group}" aria-label="Remove ${esc(name)}">✕</button></div>
    <div class="opt-row"><span>Priority per strength</span><span class="stack-tag" title="Each strength is its own bonus: different strengths add up, a second copy of the same one does nothing">strengths stack</span></div>
    <div class="level-rows">${rows}</div>
  </li>`;
}

function wantedRow(entry) {
  const e = state.gd.effectByKey(entry.effectKey);
  const missing = owned(e) ? "" : `<span class="note" title="None of ${esc(character().name)}'s relics have this">not owned</span>`;
  return `<li data-entry="${e.key}" class="${entry.minStacks > 0 ? "required" : ""}">
    <div class="row"><span class="name">${esc(wantLabel(e))}</span>${missing}<button class="icon-btn" data-remove="${e.key}" aria-label="Remove ${esc(e.name)}">✕</button></div>
    ${priorityControl(entry)}
    ${orBetterFamily(state.gd, e) ? strengthControl(e) : ""}
    ${stackRule(e).count ? stackRange(entry, e) : ""}
  </li>`;
}

const stackTag = (e) => { const r = stackRule(e); return `<span class="stack-tag${r.count ? "" : " no"}" title="${esc(r.title)}">${r.tag}</span>`; };
const strengthTick = (m) => m.name.match(/\+\d+$/)?.[0] ?? "base";

/** Minimum strength for a family: this level and every stronger one count. Ticks you own are lit. */
function strengthControl(e) {
  const family = familyOf(state.gd, e);
  const at = family.indexOf(e);
  const ownedTicks = family.filter(inRelics).map(strengthTick);
  const label = at === 0 ? "any" : `${strengthTick(e)} or stronger`;
  return `<div class="strength">
    <div class="opt-row"><span>Strength</span><b class="lvl">${label}</b></div>
    <div class="step-range" title="${esc(ownedTicks.length ? `On your relics: ${ownedTicks.join(", ")}` : "None of your relics have this")}">
      <input type="range" min="0" max="${family.length - 1}" step="1" value="${at}" data-strength aria-label="Minimum strength" />
      <div class="ticks">${family.map((m, i) => `<span class="${inRelics(m) ? "own" : ""}${i >= at ? " in" : ""}">${strengthTick(m)}</span>`).join("")}</div>
    </div>
  </div>`;
}

function stackRange(entry, e) {
  const max = maxStacksFor(e);
  const lo = Math.min(entry.minStacks, max);
  const hi = Math.min(entry.maxStacks, max);
  const pct = (v) => (max === 0 ? 0 : (v / max) * 100);
  const reach = `<span class="muted">(you can reach ${max})</span>`;
  // Effects that only stack across strengths count different strengths, not copies
  const unit = stackRule(e).tag === "strengths stack" ? "Strengths" : "Stacks";
  const desc = max === 0 ? "None of your relics have this."
    : entry.minStacks > 0 ? `${unit}: at least <b>${lo}</b>${hi > lo ? `, up to <b>${hi}</b>` : ""} ${reach}`
    : `${unit}: up to <b>${hi}</b> ${reach}`;
  return `<div class="dual-range" style="--max:${max}">
      <div class="track"></div>
      <div class="fill" style="left:calc(8px + (100% - 16px) * ${pct(lo) / 100});width:calc((100% - 16px) * ${(pct(hi) - pct(lo)) / 100})"></div>
      <input type="range" min="0" max="${max}" step="1" value="${lo}" data-range="min" aria-label="Minimum stacks (above 0 makes it required)" style="z-index:${lo >= max ? 3 : 1}" ${max === 0 ? "disabled" : ""}/>
      <input type="range" min="0" max="${max}" step="1" value="${hi}" data-range="max" aria-label="Maximum stacks" style="z-index:2" ${max === 0 ? "disabled" : ""}/>
      <div class="ticks">${Array.from({ length: max + 1 }, (_, i) => `<span>${i}</span>`).join("")}</div>
    </div>
    <div class="range-label">${desc}</div>`;
}

function avoidRow(a) {
  const e = state.gd.effectByKey(a.effectKey);
  const options = [`<option value="block" ${a.block ? "selected" : ""}>Block</option>`,
    ...RANKS.map((r) => `<option value="${r}" ${!a.block && r === a.rank ? "selected" : ""}>Avoid · ${rankName(r)}</option>`)].join("");
  const title = a.block ? "Blocked: relics with this are never used" : `Avoided: each copy costs ${avoidPenaltyForRank(a.rank)} points`;
  return `<li data-avoid="${e.key}" class="${a.block ? "blocked" : "soft"}" title="${esc(title)}">
    <span class="mark" aria-hidden="true">${a.block ? "⊘" : "▽"}</span>
    <span class="name${e.type === EffectType.Debuff ? " curse" : ""}">${esc(e.name)}</span>
    <select class="rank-select" data-avoid-rank aria-label="How strongly to avoid ${esc(e.name)}">${options}</select>
    <button class="icon-btn" data-remove-avoid="${e.key}" aria-label="Stop avoiding ${esc(e.name)}">✕</button>
  </li>`;
}

const debugButton = `<button class="btn" data-action="copy-debug">Copy debug report</button>`;

/** Plain-text report for bug reports: browser, search size and worker diagnostics. No save data. */
function debugReport() {
  const c = state.combo;
  return JSON.stringify({
    app: "Relic Vault",
    page: location.href,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGB: navigator.deviceMemory,
    jsHeapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : undefined,
    crossOriginIsolated: self.crossOriginIsolated,
    moduleWorkers: typeof Worker === "function",
    nightfarer: c.nightfarer,
    build: c.build ? toStored(state.gd, c.build) : null,
    error: c.error,
    search: lastDiagnostics,
  }, null, 2);
}

async function copyDebugReport() {
  const text = debugReport();
  console.info("[Relic Vault] debug report\n" + text);
  try {
    await navigator.clipboard.writeText(text);
    toast("Debug report copied. Paste it into a GitHub issue.");
  } catch {
    // Clipboard blocked: show it so it can be copied by hand
    const w = window.open("", "_blank");
    if (w) w.document.body.innerHTML = `<pre>${esc(text)}</pre>`;
    else toast("Copy failed; the report is in the browser console (F12).");
  }
}

function renderComboResults() {
  const el = $("#combo-results");
  if (!el) return;
  const b = state.combo.build;
  const { result, running, error } = state.combo;
  let html = "<h3>IV · Results</h3>";
  if (!b) {
    html += `<p class="muted">Pick or create a build.</p>`;
  } else if (b.wanted.length === 0) {
    html += `<p class="muted">Results appear here as soon as the build wants an effect.</p>`;
  } else {
    html += `<div class="progress ${running ? "running" : ""}"><div></div></div>`;
    if (error) html += `<div class="error-box">Search failed: ${esc(error)} ${debugButton}</div>`;
    if (result && !running) {
      html += `<p class="muted">Checked ${result.checked.toLocaleString()} combinations in ${result.ms.toLocaleString()} ms.</p>`;
      if (result.workerError) html += `<p class="muted">Ran without background workers (${esc(result.workerError)}). ${debugButton}</p>`;
    } else if (running) {
      html += `<p class="rs-loading stone">Loading - please wait.</p>`;
    }
    if (result) {
      html += result.combos.length === 0
        ? `<div class="empty"><strong>No combination found</strong><span>None of your relics can satisfy every requirement at once. Make an effect optional, loosen a stack range, or unblock a curse.</span></div>`
        : `<p>Showing the best ${result.combos.length} combos</p>` + result.combos.map((combo, i) => comboCard(combo, i, result)).join("");
    }
  }
  el.innerHTML = html;
}

function comboCard(combo, i, result) {
  const cells = combo.relics
    .map((r, slot) => {
      if (slot >= 3 && result.excludeDeep) return "";
      if (!r) return `<div class="slot-empty">${slot < 3 ? "No relic" : "No deep relic"}</div>`;
      return relicCard(r, { byColor: combo.vessel.slots[slot] !== Color.Any, highlighted: result.highlighted, isNew: state.newKeys.has(r.key), showSell: false });
    })
    .join("");
  return `<article class="combo-card">
    <header><span class="rank">#${i + 1}</span><span class="vname">${esc(combo.vessel.name)}</span><span class="meta" title="Wanted effects score most (weighted by priority), then character and recommended effects; avoided effects and curses subtract">score ${combo.points.toFixed(2)}</span></header>
    <div class="goals">${comboGoals(combo, result)}</div>
    <div class="combo-grid">${cells}</div>
  </article>`;
}

/** Checklist of the wanted effects for one combo (stacks reached), then avoided effects and other curses it carries. */
function comboGoals(combo, result) {
  const effects = combo.relics.flatMap((r, slot) => (!r || (slot >= 3 && result.excludeDeep) ? [] : r.effects.flat()));
  const nf = state.combo.nightfarer;
  const usable = effects.filter((e) => e.nightfarer === undefined || e.nightfarer === nf);
  const matches = (effect, e) => e === effect || ((effect.stacks || familyOf(state.gd, effect)) && isSameGroupAndEqualOrBetter(effect, e));
  const short = (e) => e.name.replace(/^\[[^\]]+\] /, "");
  const goals = result.entries.map((g) => {
    const n = stackCount(g.effect, usable);
    const ok = n >= Math.max(1, g.minStacks);
    const optional = !ok && g.minStacks === 0; // nice-to-have that this combo doesn't include
    const cls = ok ? "ok" : optional ? "opt" : "miss";
    const family = orBetterFamily(state.gd, g.effect) && familyOf(state.gd, g.effect);
    const name = family ? `${familyName(state.gd, g.effect).replace(/^\[[^\]]+\] /, "")}${family[0] === g.effect ? "" : ` ≥${strengthTick(g.effect)}`}` : short(g.effect);
    return `<span class="goal ${cls}" title="${esc(g.effect.name)}${family && family[0] !== g.effect ? " or stronger" : ""}${g.minStacks > 0 ? " (required)" : ""}">${ok ? "✓" : optional ? "○" : "✗"} ${esc(name)}${g.effect.stacks && n > 1 ? ` ×${n}` : ""}</span>`;
  });
  const avoided = result.avoided
    .map((a) => [a, effects.filter((e) => matches(a.effect, e)).length])
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `<span class="goal avoid" title="Avoided: ${esc(a.effect.name)}">▽ ${esc(short(a.effect))}${n > 1 ? ` ×${n}` : ""}</span>`);
  const curses = effects.filter((e) => e.type === EffectType.Debuff && !result.avoided.some((a) => matches(a.effect, e)));
  // Every curse by name (avoided ones are already listed above), with a count when one repeats
  const counts = new Map();
  for (const c of curses) counts.set(c, (counts.get(c) ?? 0) + 1);
  const curseChips = [...counts].map(([c, n]) => `<span class="goal curse" title="Curse: ${esc(c.name)}">⚠ ${esc(c.name)}${n > 1 ? ` ×${n}` : ""}</span>`).join("");
  const curseRow = curses.length
    ? `<div class="goal-curses">${curseChips}</div>`
    : (result.excludeDeep || avoided.length ? "" : '<span class="goal ok">No curses</span>');
  return goals.join("") + avoided.join("") + curseRow;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireGlobalEvents() {
  $("#file-input").addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (f) loadFile(f);
    ev.target.value = "";
  });

  const wantedEntry = (el) => state.combo.build?.wanted.find((e) => e.effectKey === Number(el.closest("[data-entry]")?.dataset.entry));
  const avoidEntry = (el) => state.combo.build?.avoid.find((e) => e.effectKey === Number(el.closest("[data-avoid]")?.dataset.avoid));

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.matches("[data-file]") && t.files?.[0]) return loadFile(t.files[0]);
    if (t.closest("#character-picker") && t.tagName === "SELECT") {
      state.charIndex = Number(t.value);
      store.set(`char:${state.saveId}`, character().index);
      updateNewRelics();
      state.combo.result = null;
      renderAll();
      return;
    }
    if (t.matches("[data-save-select]")) {
      state.combo.result = null;
      return loadLive(t.value);
    }
    if (t.dataset.toggle) {
      state.browse[t.dataset.toggle] = t.checked;
      return renderBrowseGrid();
    }
    if (t.matches("[data-want-rank]")) {
      const entry = wantedEntry(t);
      if (t.value === "req") {
        entry.minStacks = Math.max(1, entry.minStacks);
        entry.maxStacks = Math.max(entry.maxStacks, entry.minStacks);
      } else {
        entry.rank = clampRank(t.value);
        entry.minStacks = 0;
      }
      return comboChanged();
    }
    if (t.matches("[data-level-rank]")) {
      const key = Number(t.closest("[data-level]").dataset.level);
      const b = state.combo.build;
      let entry = b.wanted.find((w) => w.effectKey === key);
      if (t.value === "") {
        b.wanted = b.wanted.filter((w) => w.effectKey !== key);
      } else {
        if (!entry) b.wanted.push((entry = newWanted(state.gd, state.gd.effectByKey(key))));
        if (t.value === "req") entry.minStacks = 1;
        else { entry.rank = clampRank(t.value); entry.minStacks = 0; }
      }
      return comboChanged();
    }
    if (t.matches("[data-avoid-rank]")) {
      const entry = avoidEntry(t);
      entry.block = t.value === "block";
      if (!entry.block) entry.rank = clampRank(t.value);
      return comboChanged();
    }
    // Re-sort once a stack slider is let go: it may have switched between required and ranked
    if (t.dataset.range) return renderCombo();
    if (t.matches("[data-strength]")) return comboChanged();
    if (t.name === "nf") {
      state.combo.nightfarer = Number(t.value);
      state.combo.build = null;
      state.combo.ui = {};
      state.combo.result = null;
      saveNightfarer();
      renderCombo();
      return scheduleSearch();
    }
    if (t.dataset.combo === "include-deep") {
      state.combo.build.includeDeep = t.checked;
      return comboChanged();
    }
  });

  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.matches("[data-strength]")) {
      // Swap the entry to the chosen strength; the card re-renders when the slider is let go
      const li = t.closest("[data-entry]");
      const entry = wantedEntry(t);
      const family = familyOf(state.gd, state.gd.effectByKey(entry.effectKey));
      Object.assign(entry, fitStacks(state.gd, { ...entry, effectKey: family[Number(t.value)].key }));
      li.dataset.entry = entry.effectKey;
      const fresh = document.createElement("div");
      fresh.innerHTML = strengthControl(state.gd.effectByKey(entry.effectKey));
      li.querySelector(".strength .lvl").replaceWith(fresh.querySelector(".lvl"));
      li.querySelector(".strength .ticks").replaceWith(fresh.querySelector(".ticks"));
      return comboChanged({ rerender: false });
    }
    if (!t.dataset.range) return;
    const li = t.closest("[data-entry]");
    const entry = wantedEntry(t);
    const [minEl, maxEl] = li.querySelectorAll("input[type=range]");
    let lo = Number(minEl.value), hi = Number(maxEl.value);
    // A wanted effect allows at least 1 copy; ruling an effect out is what the Avoid list is for
    if (hi < 1 && Number(maxEl.max) >= 1) { hi = 1; maxEl.value = 1; }
    if (lo > hi) {
      if (t === minEl) hi = lo; else lo = hi;
      minEl.value = lo; maxEl.value = hi;
    }
    // A minimum above 0 is what makes an effect required
    entry.minStacks = lo;
    entry.maxStacks = hi;
    // Update this row in place so the slider keeps focus while dragging
    const fresh = document.createElement("div");
    fresh.innerHTML = wantedRow(entry);
    for (const sel of [".prio", ".fill", ".range-label"]) li.querySelector(sel).replaceWith(fresh.querySelector(sel));
    li.classList.toggle("required", lo > 0);
    comboChanged({ rerender: false });
  });

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button, [data-filter]");
    if (!t) return;
    if (t.closest("#tabs") && t.dataset.tab) {
      state.tab = t.dataset.tab;
      store.set("tab", state.tab);
      renderTabs();
      if (state.tab === "combo") { renderCombo(); scheduleSearch(); }
      else renderBrowse();
      return;
    }
    if (t.dataset.filter !== undefined) {
      state.browse.filter = Number(t.dataset.filter);
      store.set("browse.filter", state.browse.filter);
      for (const b of document.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b === t));
      return renderBrowseGrid();
    }
    if (t.dataset.compare) return openCompare(t.dataset.compare);
    const b = state.combo.build;
    if (t.dataset.buildPick) {
      if (t.dataset.buildPick === b?.id) return;
      selectBuild(t.dataset.buildPick);
      renderCombo();
      return scheduleSearch();
    }
    if (t.dataset.remove) {
      b.wanted = b.wanted.filter((e) => e.effectKey !== Number(t.dataset.remove));
      return comboChanged();
    }
    if (t.dataset.removeFamily) {
      b.wanted = b.wanted.filter((w) => state.gd.effectByKey(w.effectKey).group !== Number(t.dataset.removeFamily) || !perStrength(state.gd, state.gd.effectByKey(w.effectKey)));
      return comboChanged();
    }
    if (t.dataset.removeAvoid) {
      b.avoid = b.avoid.filter((e) => e.effectKey !== Number(t.dataset.removeAvoid));
      return comboChanged();
    }
    if (t.dataset.curse) { b.cursePenalty = t.dataset.curse; return comboChanged(); }
    switch (t.dataset.build) {
      case "new": return startNaming("creating");
      case "rename": return startNaming("renaming");
      case "duplicate": return startNaming("duplicating");
      case "confirm-name": return confirmName();
      case "delete": state.combo.ui = { confirmDelete: true }; return renderCombo();
      case "confirm-delete": return deleteBuild();
      case "cancel": state.combo.ui = {}; return renderCombo();
    }
    if (t.dataset.action === "mark-seen") return markAllSeen();
    if (t.dataset.action === "copy-debug") return copyDebugReport();
    if (t.dataset.action === "back-live") return loadLive(state.saves[0].id);
  });

  document.addEventListener("keydown", (ev) => {
    if (!ev.target.matches?.("[data-build-name]")) return;
    if (ev.key === "Enter") { ev.preventDefault(); confirmName(); }
    if (ev.key === "Escape") { state.combo.ui = {}; renderCombo(); }
  });

  // Drag & drop a save anywhere
  let depth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { depth++; $("#drop-overlay").hidden = false; } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("#drop-overlay").hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    $("#drop-overlay").hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
}

boot();
