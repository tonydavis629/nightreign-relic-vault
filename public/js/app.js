// Relic Vault — main UI.
import { buildSearch } from "./combo-core.js";
import { SearchCancelled, cancelSearch, lastDiagnostics, searchCombos } from "./combo-client.js";
import { Color, EffectType, ItemType, RELIC_COLORS, createGameData, isSameGroup, isSameGroupAndEqualOrBetter, relicEffectCount, relicHasEffect } from "./game-data.js";
import { availableEffects as computeAvailableEffects, buildCharacter } from "./model.js";
import { DEFAULT_RANK, MAX_RANK, clampRank, rankLabel, rankOf, weightForRank } from "./priority.js";
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
    settings: store.get("combo.settings", {}),
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
    state.gd = createGameData(await (await fetch("data/game-data.json")).json(), mmv);
    state.presets = await fetch("data/presets.json").then((r) => (r.ok ? r.json() : []), () => []);
  } catch (err) {
    return showFatal(`Could not load game data (data/game-data.json): ${err.message}`);
  }
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
    <h1>Your relics, outside the game</h1>
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
// Combo Finder tab
// ---------------------------------------------------------------------------
function comboSettings(nf = state.combo.nightfarer) {
  const s = state.combo.settings[nf] ?? (state.combo.settings[nf] = { disabledVessels: [], selectedEffects: [], excludeDeepEffects: false });
  s.disabledVessels ??= [];
  s.selectedEffects ??= [];
  s.cursePenalty ??= "light";
  // Drop entries whose effect no longer exists in the data
  s.selectedEffects = s.selectedEffects.filter((e) => state.gd.effectByKey(e.effectKey) && !state.gd.effectByKey(e.effectKey).unknown);
  for (const e of s.selectedEffects) {
    e.rank = rankOf(e);
    e.weight = weightForRank(e.rank);
  }
  return s;
}
function saveComboSettings() {
  store.set("combo.settings", state.combo.settings);
  store.set("combo.nightfarer", state.combo.nightfarer);
}

const nightfarer = () => state.gd.nightfarers.find((n) => n.id === state.combo.nightfarer) ?? state.gd.nightfarers[0];
const enabledVessels = () => {
  const s = comboSettings();
  return nightfarer().vessels.filter((_, i) => !s.disabledVessels.includes(i));
};
const orBetter = (e) => e.stacks && !e.maxLevel;
const effectLabel = (e) => `${e.name}${orBetter(e) ? " (or better)" : ""}`;

/**
 * Every effect this Nightfarer can use: their own effects first, then A-Z with MMV-only ones last. Effects in none of
 * the character's relics are listed too (dimmed by the picker). MMV-only effects are offered
 * on modded saves, or when a relic has one.
 */
function selectableEffects() {
  const nf = state.combo.nightfarer;
  const exclude = comboSettings().excludeDeepEffects;
  const have = new Set(availableEffects(character()));
  const modded = /\.co2$/i.test(state.fileName ?? "");
  return state.gd.effectsByKey
    .filter((e) =>
      e && !e.unknown &&
      (!e.mmv || modded || have.has(e)) &&
      (e.nightfarer === undefined || e.nightfarer === nf || ALWAYS_SELECTABLE.has(e.slug)) &&
      (!exclude || e.type !== EffectType.Debuff))
    .sort((a, b) => (b.nightfarer === nf) - (a.nightfarer === nf) || Boolean(a.mmv) - Boolean(b.mmv) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
const notInRelicsHint = (e) => (availableEffects(character()).includes(e) ? "" : "not in your relics");

/** Most copies of `effect` that one enabled vessel could hold with this character's relics. */
function maxStacksFor(effect) {
  if (effect.stacks !== true) return 1;
  const c = character();
  const exclude = comboSettings().excludeDeepEffects;
  const normal = c.relics.filter((r) => !r.isDeep && relicHasEffect(r, effect));
  const deep = c.relics.filter((r) => r.isDeep && relicHasEffect(r, effect));
  let best = 0;
  for (const vessel of enabledVessels()) {
    const used = [];
    let total = 0;
    vessel.slots.forEach((slot, i) => {
      if (i >= 3 && exclude) return;
      const pool = (i >= 3 ? deep : normal).filter((r) => slot === Color.Any || r.color === slot);
      let max = 0, pick;
      for (const r of pool) {
        if (used.includes(r)) continue;
        const n = relicEffectCount(r, effect);
        if (n > max) { max = n; pick = r; }
      }
      total += max;
      if (pick) used.push(pick);
    });
    best = Math.max(best, total);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Builds: named Combo Finder setups, from data/presets.json plus the ones saved in this
// browser, shown as one list. Effects are stored by name (slug) so they survive data updates.
// The server never writes files, so deleting a presets.json build just hides it here.
// ---------------------------------------------------------------------------
const userBuilds = () => store.get("builds", []);
const hiddenPresets = () => store.get("builds.hidden", []);
const allBuilds = () => [...(state.presets ?? []).filter((b) => !hiddenPresets().includes(b.id)).map((b) => ({ ...b, fromFile: true })), ...userBuilds()];

function buildsBar() {
  if (state.combo.savingBuild) {
    return `<div class="builds"><input class="text-input plain" data-build-name placeholder="Name this build" maxlength="60" autofocus />
      <button class="btn btn-primary" data-build="confirm-save">Save</button><button class="btn btn-ghost" data-build="cancel-save">Cancel</button></div>`;
  }
  const builds = allBuilds();
  const loaded = builds.find((b) => b.id === state.combo.loadedBuild);
  const opt = (b) => `<option value="${esc(b.id)}" ${b.id === state.combo.loadedBuild ? "selected" : ""}>${esc(b.name)}</option>`;
  return `<div class="builds">
    <select data-build-select aria-label="Load a build">
      <option value="">${builds.length ? "Load a build…" : "No saved builds yet"}</option>
      ${builds.map(opt).join("")}
    </select>
    <button class="btn" data-build="save" title="Save the current Nightfarer, effects, priorities and curse setting">Save…</button>
    ${loaded ? `<button class="btn btn-ghost" data-build="delete" title="Delete this saved build">Delete</button>` : ""}
  </div>`;
}

function loadBuild(id) {
  const build = allBuilds().find((b) => b.id === id);
  if (!build) return;
  const bySlug = new Map(state.gd.effectsByKey.filter(Boolean).map((e) => [e.slug, e]));
  const entries = [];
  const missing = [];
  for (const e of build.effects) {
    const effect = bySlug.get(e.slug);
    if (!effect) { missing.push(e.slug); continue; }
    const rank = rankOf(e);
    entries.push({ effectKey: effect.key, minStacks: e.min ?? 0, maxStacks: e.max ?? (effect.stacks ? 10 : 1), rank, weight: weightForRank(rank) });
  }
  state.combo.nightfarer = build.nightfarer;
  const s = comboSettings();
  s.selectedEffects = entries;
  s.excludeDeepEffects = Boolean(build.excludeDeepEffects);
  s.cursePenalty = CURSE_PENALTY[build.cursePenalty] ? build.cursePenalty : "light";
  state.combo.loadedBuild = id;
  state.combo.result = null;
  const have = new Set(availableEffects(character()));
  const absent = entries.filter((e) => e.maxStacks > 0 && !have.has(state.gd.effectByKey(e.effectKey))).length;
  toast(`Loaded "${build.name}"${absent ? ` — ${absent} effect(s) aren't on ${character().name}'s relics` : ""}${missing.length ? ` — ${missing.length} unknown effect(s) skipped` : ""}`);
  comboChanged();
}

function saveBuild() {
  state.combo.savingBuild = true;
  renderCombo();
  $("[data-build-name]")?.focus();
}

function confirmSaveBuild() {
  const name = $("[data-build-name]")?.value.trim();
  if (!name) return $("[data-build-name]")?.focus();
  const s = comboSettings();
  const build = {
    id: `user-${Date.now().toString(36)}`,
    name,
    nightfarer: state.combo.nightfarer,
    excludeDeepEffects: s.excludeDeepEffects,
    cursePenalty: s.cursePenalty,
    effects: s.selectedEffects.map((e) => ({ slug: state.gd.effectByKey(e.effectKey).slug, min: e.minStacks, max: e.maxStacks, priority: e.rank })),
  };
  store.set("builds", [...userBuilds(), build]);
  state.combo.savingBuild = false;
  state.combo.loadedBuild = build.id;
  toast(`Saved build "${name}"`);
  renderCombo();
}

function deleteBuild() {
  const id = state.combo.loadedBuild;
  store.set("builds", userBuilds().filter((b) => b.id !== id));
  if ((state.presets ?? []).some((b) => b.id === id)) store.set("builds.hidden", [...hiddenPresets(), id]);
  state.combo.loadedBuild = null;
  renderCombo();
}

function addEffect(effect) {
  const s = comboSettings();
  if (s.selectedEffects.some((e) => e.effectKey === effect.key)) return;
  // Same rules as upstream: a stackable effect replaces other levels of its group,
  // and only one "starting armament" bonus of each kind can apply.
  s.selectedEffects = s.selectedEffects.filter((entry) => {
    const e = state.gd.effectByKey(entry.effectKey);
    if (isSameGroup(e, effect) && e.stacks === true && effect.stacks === true) return false;
    if (e.startingBonus !== undefined && e.startingBonus === effect.startingBonus) return false;
    return true;
  });
  s.selectedEffects.push({ effectKey: effect.key, minStacks: 0, maxStacks: effect.stacks ? 10 : 1, rank: DEFAULT_RANK, weight: weightForRank(DEFAULT_RANK) });
  comboChanged();
  $("#combo-picker input")?.focus(); // keep typing to add more
}

function comboChanged({ rerender = true } = {}) {
  saveComboSettings();
  if (rerender) renderCombo();
  scheduleSearch();
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runComboSearch, 150);
}

async function runComboSearch() {
  const s = comboSettings();
  const selected = s.selectedEffects.map((e) => state.gd.effectByKey(e.effectKey));
  const vessels = enabledVessels();
  if (selected.length === 0 || vessels.length === 0) {
    cancelSearch();
    Object.assign(state.combo, { result: null, running: false, error: null });
    return renderComboResults();
  }
  const c = character();
  const built = buildSearch(state.gd, {
    nightfarer: state.combo.nightfarer,
    selectedEffects: selected,
    relics: c.relics.filter((r) => r.item.type === ItemType.Relic || r.item.type === ItemType.UniqueRelic),
    deepRelics: s.excludeDeepEffects ? [] : c.relics.filter((r) => r.item.type === ItemType.DeepRelic),
    enabledVessels: vessels,
    selectedEntries: s.selectedEffects,
    cursePenalty: CURSE_PENALTY[s.cursePenalty]?.value ?? 0,
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
      entries: s.selectedEffects.map((e) => ({ ...e, effect: state.gd.effectByKey(e.effectKey) })),
      excludeDeep: s.excludeDeepEffects,
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

function renderCombo() {
  const s = comboSettings();
  const nf = nightfarer();
  const exclude = s.excludeDeepEffects;
  $("#app").innerHTML = `<div class="combo">
    <section>
      <h3>I · Nightfarer</h3>
      <div class="nf-list">${state.gd.nightfarers.map((n) => `<label><input type="radio" name="nf" value="${n.id}" ${n.id === nf.id ? "checked" : ""}/> ${esc(n.name)}</label>`).join("")}</div>
    </section>
    <section>
      <h3>II · Vessels</h3>
      <label class="switch"><input type="checkbox" data-combo="include-deep" ${exclude ? "" : "checked"}/> Include deep relic slots</label>
      <div class="vessel-tools"><button class="btn" data-combo="all-vessels">All</button><button class="btn" data-combo="no-vessels">None</button></div>
      ${nf.vessels.map((v, i) => {
        const off = s.disabledVessels.includes(i);
        return `<label class="vessel ${off ? "off" : ""}">
          <div class="vessel-top"><span>${esc(v.name)}</span><input type="checkbox" data-vessel="${i}" ${off ? "" : "checked"}/></div>
          <div class="vessel-slots">${v.slots.map((color, si) => (si < 3 || !exclude ? colorChip(color, si >= 3, off ? "off" : "") : "")).join("")}</div>
        </label>`;
      }).join("")}
    </section>
    <section>
      <h3>III · Effects</h3>
      ${buildsBar()}
      <div id="combo-picker"></div>
      <div class="opt-row" title="Deep relics carry curses. Upstream ignores them; a penalty steers the optimizer toward cleaner relics.">
        <span>Curses</span>
        <div class="segmented small">${Object.entries(CURSE_PENALTY).map(([k, v]) => `<button type="button" data-curse="${k}" aria-pressed="${s.cursePenalty === k}">${v.label}</button>`).join("")}</div>
      </div>
      <ul class="picked">${[...s.selectedEffects].sort((a, b) => a.rank - b.rank).map((entry) => pickedEffectRow(entry)).join("")}</ul>
      ${s.selectedEffects.length === 0 ? `<p class="muted" style="margin-top:14px">Pick the effects you want. Only effects that exist on ${esc(character().name)}'s relics are listed. Stackable effects match "this level or better".</p>` : ""}
    </section>
    <section class="results" id="combo-results"></section>
  </div>`;

  effectPicker($("#combo-picker"), {
    placeholder: "Search effects…",
    getOptions: selectableEffects,
    label: effectLabel,
    hint: notInRelicsHint,
    clearOnPick: true,
    onPick: addEffect,
  });
  renderComboResults();
}

function pickedEffectRow(entry) {
  const e = state.gd.effectByKey(entry.effectKey);
  const max = maxStacksFor(e);
  const lo = Math.min(entry.minStacks, max);
  const hi = Math.min(entry.maxStacks, max);
  const pct = (v) => (max === 0 ? 0 : (v / max) * 100);
  const desc = hi === 0 ? "<b>Excluded</b>: combos must not contain this effect"
    : `Stacks: <b>${lo === hi ? lo : `${lo} – ${hi}`}</b> <span class="muted">(you can reach ${max})</span>`;
  return `<li data-entry="${e.key}">
    <div class="row"><span class="name ${e.type === EffectType.Debuff ? "curse" : ""}">${esc(effectLabel(e))}</span><button class="icon-btn" data-remove="${e.key}" aria-label="Remove ${esc(e.name)}">✕</button></div>
    ${hi === 0 && entry.maxStacks === 0 ? "" : priorityRow(entry, lo > 0)}
    <div class="dual-range" style="--max:${max}">
      <div class="track"></div>
      <div class="fill" style="left:calc(8px + (100% - 16px) * ${pct(lo) / 100});width:calc((100% - 16px) * ${(pct(hi) - pct(lo)) / 100})"></div>
      <input type="range" min="0" max="${max}" step="1" value="${lo}" data-range="min" aria-label="Minimum stacks" style="z-index:${lo >= max ? 3 : 1}" ${max === 0 ? "disabled" : ""}/>
      <input type="range" min="0" max="${max}" step="1" value="${hi}" data-range="max" aria-label="Maximum stacks" style="z-index:2" ${max === 0 ? "disabled" : ""}/>
      <div class="ticks">${Array.from({ length: max + 1 }, (_, i) => `<span>${i}</span>`).join("")}</div>
    </div>
    <div class="range-label">${desc}</div>
  </li>`;
}

function priorityRow(entry, required) {
  const rank = entry.rank;
  const options = Array.from({ length: MAX_RANK }, (_, i) => i + 1)
    .map((r) => `<option value="${r}" ${r === rank ? "selected" : ""}>${rankLabel(r)}</option>`).join("");
  const pips = Array.from({ length: MAX_RANK }, (_, i) => `<i class="${i < MAX_RANK + 1 - rank ? "on" : ""}"></i>`).join("");
  return `<div class="opt-row">
    <span>Priority</span>
    <select class="rank-select" data-rank aria-label="Priority rank, 1 is most important">${options}</select>
    <span class="pips" title="Scores ×${weightForRank(rank)} (rank 1 ×3 … rank 12 ×0.25)">${pips}</span>
    ${required ? '<span class="must">Required</span>' : ""}
  </div>`;
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
    settings: comboSettings(),
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
  const s = comboSettings();
  const { result, running, error } = state.combo;
  let html = "<h3>IV · Results</h3>";
  if (s.selectedEffects.length === 0) {
    html += `<p class="muted">Results appear here as soon as you pick an effect.</p>`;
  } else if (enabledVessels().length === 0) {
    html += `<p class="muted">Enable at least one vessel.</p>`;
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
        ? `<div class="empty"><strong>No combination found</strong><span>None of your relics can satisfy every requirement at once. Loosen a stack range or enable more vessels.</span></div>`
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
  const { goals, curses } = comboGoals(combo, result);
  const curseChip = curses.length
    ? `<span class="goal curse" title="${esc(curses.map((c) => c.name).join("\n"))}">⚠ ${curses.length} curse${curses.length === 1 ? "" : "s"}</span>`
    : (result.excludeDeep ? "" : '<span class="goal ok">No curses</span>');
  return `<article class="combo-card">
    <header><span class="rank">#${i + 1}</span><span class="vname">${esc(combo.vessel.name)}</span><span class="meta" title="Selected effects score most (weighted by priority), then character and recommended effects; curses subtract when a penalty is set">score ${combo.points.toFixed(2)}</span></header>
    <div class="goals">${goals}${curseChip}</div>
    <div class="combo-grid">${cells}</div>
  </article>`;
}

/** Checklist of the selected goals for one combo (stacks reached), plus the curses it carries. */
function comboGoals(combo, result) {
  const effects = combo.relics.flatMap((r, slot) => (!r || (slot >= 3 && result.excludeDeep) ? [] : r.effects.flat()));
  const nf = state.combo.nightfarer;
  const usable = effects.filter((e) => e.nightfarer === undefined || e.nightfarer === nf);
  const goals = result.entries
    .filter((g) => g.maxStacks > 0)
    .map((g) => {
      const n = usable.filter((e) => e === g.effect || (g.effect.stacks && isSameGroupAndEqualOrBetter(g.effect, e))).length;
      const ok = n >= Math.max(1, g.minStacks);
      const optional = !ok && g.minStacks === 0; // nice-to-have that this combo doesn't include
      const label = g.effect.name.replace(/^\[[^\]]+\] /, "");
      const cls = ok ? "ok" : optional ? "opt" : "miss";
      return `<span class="goal ${cls}" title="${esc(g.effect.name)}${optional ? " (optional)" : ""}">${ok ? "✓" : optional ? "○" : "✗"} ${esc(label)}${g.effect.stacks && n > 1 ? ` ×${n}` : ""}</span>`;
    })
    .join("");
  const selectedKeys = new Set(result.entries.map((g) => g.effectKey));
  const curses = effects.filter((e) => e.type === EffectType.Debuff && !selectedKeys.has(e.key));
  return { goals, curses };
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
    if (t.matches("[data-build-select]")) return t.value ? loadBuild(t.value) : undefined;
    if (t.matches("[data-rank]")) {
      const key = Number(t.closest("[data-entry]").dataset.entry);
      const entry = comboSettings().selectedEffects.find((e) => e.effectKey === key);
      entry.rank = clampRank(t.value);
      entry.weight = weightForRank(entry.rank);
      return comboChanged();
    }
    if (t.name === "nf") {
      state.combo.nightfarer = Number(t.value);
      state.combo.loadedBuild = null;
      state.combo.result = null;
      return comboChanged();
    }
    if (t.dataset.vessel !== undefined) {
      const s = comboSettings();
      const i = Number(t.dataset.vessel);
      s.disabledVessels = t.checked ? s.disabledVessels.filter((x) => x !== i) : [...s.disabledVessels, i];
      return comboChanged();
    }
    if (t.dataset.combo === "include-deep") {
      comboSettings().excludeDeepEffects = !t.checked;
      if (!t.checked) {
        // Curses only exist on deep relics; drop them when deep slots are off
        const s = comboSettings();
        s.selectedEffects = s.selectedEffects.filter((e) => state.gd.effectByKey(e.effectKey).type !== EffectType.Debuff);
      }
      return comboChanged();
    }
  });

  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t.dataset.range) return;
    const li = t.closest("[data-entry]");
    const key = Number(li.dataset.entry);
    const entry = comboSettings().selectedEffects.find((e) => e.effectKey === key);
    const [minEl, maxEl] = li.querySelectorAll("input[type=range]");
    let lo = Number(minEl.value), hi = Number(maxEl.value);
    if (lo > hi) {
      if (t === minEl) hi = lo; else lo = hi;
      minEl.value = lo; maxEl.value = hi;
    }
    entry.minStacks = lo;
    entry.maxStacks = hi;
    // Update this row in place so the slider keeps focus while dragging
    const fresh = document.createElement("div");
    fresh.innerHTML = pickedEffectRow(entry);
    li.querySelector(".fill").replaceWith(fresh.querySelector(".fill"));
    li.querySelector(".range-label").replaceWith(fresh.querySelector(".range-label"));
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
    if (t.dataset.remove) {
      const s = comboSettings();
      s.selectedEffects = s.selectedEffects.filter((e) => e.effectKey !== Number(t.dataset.remove));
      return comboChanged();
    }
    if (t.dataset.curse) { comboSettings().cursePenalty = t.dataset.curse; return comboChanged(); }
    if (t.dataset.build === "save") return saveBuild();
    if (t.dataset.build === "confirm-save") return confirmSaveBuild();
    if (t.dataset.build === "cancel-save") { state.combo.savingBuild = false; return renderCombo(); }
    if (t.dataset.build === "delete") return deleteBuild();
    if (t.dataset.combo === "all-vessels") { comboSettings().disabledVessels = []; return comboChanged(); }
    if (t.dataset.combo === "no-vessels") { comboSettings().disabledVessels = nightfarer().vessels.map((_, i) => i); return comboChanged(); }
    if (t.dataset.action === "mark-seen") return markAllSeen();
    if (t.dataset.action === "copy-debug") return copyDebugReport();
    if (t.dataset.action === "back-live") return loadLive(state.saves[0].id);
  });

  document.addEventListener("keydown", (ev) => {
    if (!ev.target.matches?.("[data-build-name]")) return;
    if (ev.key === "Enter") { ev.preventDefault(); confirmSaveBuild(); }
    if (ev.key === "Escape") { state.combo.savingBuild = false; renderCombo(); }
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
