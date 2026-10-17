// Small DOM helpers and shared components (relic card, effect picker).
import { COLOR_NAMES, EffectType, isSameGroupAndEqualOrBetter } from "./game-data.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Escapes `text` and wraps case-insensitive occurrences of `term` in <mark>. */
export function highlight(text, term) {
  if (!term) return esc(text);
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  let out = "", i = 0, j;
  while ((j = lower.indexOf(t, i)) !== -1) {
    out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + t.length)) + "</mark>";
    i = j + t.length;
  }
  return out + esc(text.slice(i));
}

export function colorChip(color, deep = false, extra = "") {
  return `<span class="chip c${color}${deep ? " deep" : ""}${extra ? " " + extra : ""}">${COLOR_NAMES[color]}</span>`;
}

const coordsTitle = (relic, byColor) =>
  byColor
    ? `Find it in-game: sort by "Order Found", filter by ${COLOR_NAMES[relic.color]} and type ${relic.isDeep ? "Depths Relic" : "Relic"}.`
    : `Find it in-game: sort by "Order Found"${relic.isDeep ? " on the Depths Relic tab" : ""}.`;

/**
 * Renders a relic card as an HTML string.
 * @param opts.search      term to highlight
 * @param opts.byColor     show coordinates within the relic's color filter
 * @param opts.highlighted selected Combo Finder effects to emphasize
 * @param opts.isNew       mark as newly acquired
 * @param opts.showSell    show the SELL chip when the relic is redundant
 */
export function relicCard(relic, { search = "", byColor = false, highlighted = null, isNew = false, showSell = true } = {}) {
  const tier = Math.min(relic.effects.length, 4);
  const cls = ["relic", `t${tier}`, `c${relic.color}`, relic.isDeep && "deep", relic.isUnique && "unique", isNew && "is-new"].filter(Boolean).join(" ");
  const hit = (e) => highlighted && (highlighted.includes(e) || highlighted.some((h) => isSameGroupAndEqualOrBetter(h, e)));
  const effects = relic.effects
    .map(([e, curse]) => {
      const state = highlighted ? (hit(e) ? "hit" : "dim") : "";
      const curseHtml = curse ? `<span class="curse${highlighted && hit(curse) ? " hit" : ""}">${highlight(curse.name, search)}</span>` : "";
      return `<li class="${state}">${highlight(e.name, search)}${curseHtml}</li>`;
    })
    .join("");
  const [row, col] = byColor ? relic.coordinatesByColor : relic.coordinates;
  const sell = showSell && relic.redundant && relic.sellable
    ? `<button type="button" class="chip sell" data-compare="${esc(relic.uid)}" title="${relic.redundant.outclassed ? "Outclassed by a better relic" : "Duplicate of another relic"} — click to compare">SELL</button>`
    : "";
  return `<article class="${cls}" data-uid="${esc(relic.uid)}">
    <div class="relic-head">
      <div class="relic-name">${highlight(relic.name, search)}</div>
      ${isNew ? '<span class="chip new" title="New since you last marked relics as seen">NEW!</span>' : ""}${sell}${colorChip(relic.color, relic.isDeep)}
    </div>
    <ul>${effects}</ul>
    <span class="coords${byColor ? ` c${relic.color}` : ""}" title="${esc(coordsTitle(relic, byColor))}">Row ${row + 1}, Column ${col + 1}</span>
  </article>`;
}

/**
 * Autocomplete over effects. Calls onPick(effect) when an option is chosen and
 * onInput(text) on every keystroke (for free-text search).
 */
export function effectPicker(container, { placeholder, getOptions, label = (e) => e.name, onPick, onInput, clearOnPick = false }) {
  container.classList.add("search");
  container.innerHTML = `<input type="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-autocomplete="list" role="combobox" aria-expanded="false" />
    <ul class="suggestions" role="listbox" hidden></ul>`;
  const input = container.querySelector("input");
  const list = container.querySelector("ul");
  let options = [], active = -1;

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    options = getOptions().filter((e) => !q || label(e).toLowerCase().includes(q)).slice(0, 80);
    if (options.length === 0 || document.activeElement !== input) return close();
    list.innerHTML = options
      .map((e, i) => `<li role="option" data-i="${i}" class="${e.type === EffectType.Debuff ? "curse" : ""}" aria-selected="${i === active}">${highlight(label(e), q)}</li>`)
      .join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const pick = (i) => {
    const e = options[i];
    if (!e) return;
    input.value = clearOnPick ? "" : e.name;
    close();
    onPick?.(e);
    if (!clearOnPick) onInput?.(input.value);
  };

  input.addEventListener("input", () => { active = -1; render(); onInput?.(input.value); });
  input.addEventListener("click", render);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (list.hidden) render();
      active = Math.max(0, Math.min(options.length - 1, active + (ev.key === "ArrowDown" ? 1 : -1)));
      render();
      list.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      if (active >= 0) { ev.preventDefault(); pick(active); }
      else if (clearOnPick && options.length > 0 && input.value.trim()) { ev.preventDefault(); pick(0); }
    } else if (ev.key === "Escape") {
      // type=search clears itself on Esc natively; only do that when no list is open
      ev.preventDefault();
      if (!list.hidden) { close(); ev.stopPropagation(); }
      else if (input.value) { input.value = ""; onInput?.(""); }
    }
  });
  list.addEventListener("mousedown", (ev) => {
    const li = ev.target.closest("li");
    if (li) { ev.preventDefault(); pick(Number(li.dataset.i)); }
  });
  return { input, setValue: (v) => { input.value = v; }, refresh: render };
}

// Messages appear in a RuneScape-style chatbox: newest at the bottom, fades when idle.
let toastTimer, fadeTimer;
export function toast(message, ms = 6000) {
  const el = $("#toast");
  const line = document.createElement("div");
  line.innerHTML = `<b>Relic Vault:</b> ${esc(message)}`;
  el.append(line);
  while (el.children.length > 4) el.firstElementChild.remove();
  el.hidden = false;
  el.classList.remove("fading");
  clearTimeout(toastTimer);
  clearTimeout(fadeTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("fading");
    fadeTimer = setTimeout(() => { el.hidden = true; el.replaceChildren(); el.classList.remove("fading"); }, 450);
  }, ms);
}

/** Elden Ring style full-width announcement ("RELICS RETRIEVED"). */
let bannerTimer;
export function banner(text) {
  const el = $("#banner");
  if (!el) return;
  el.querySelector("span").textContent = text;
  el.classList.remove("play");
  void el.offsetWidth; // restart the animation
  el.classList.add("play");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove("play"), 2600);
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}
