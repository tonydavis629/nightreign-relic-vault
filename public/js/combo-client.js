// Runs combo searches on a pool of workers (one vessel per task), mirroring upstream's
// rayon-parallel loop over vessels. Starting a new search cancels the previous one by
// terminating the pool, since a running search is synchronous inside its worker.
//
// If a worker can't start or dies without a reason (old browser, blocked script, extension,
// out of memory), the search reruns on the main thread and the failure is kept in
// `lastDiagnostics` for the "Copy debug report" button.
import { mergeResults, runSearch } from "./combo-core.js";

const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const WORKER_URL = new URL("./combo-worker.js", import.meta.url);
let pool = [];
let rejectCurrent = null;
let workersBroken = null; // first worker failure; later searches go straight to the main thread

/** What happened in the most recent search (shown in the debug report). */
export let lastDiagnostics = null;

export class SearchCancelled extends Error {}

export function cancelSearch() {
  for (const w of pool) w.terminate();
  pool = [];
  if (rejectCurrent) {
    const reject = rejectCurrent;
    rejectCurrent = null;
    reject(new SearchCancelled("cancelled"));
  }
}

const inputStats = (input) => ({
  relics: input.relics.length,
  deepRelics: input.deep_relics.length,
  selectedEffects: input.selected_effects.length,
  recommendedEffects: input.recommended_effects.length,
  ranges: (input.selected_effect_ranges ?? []).filter((r) => r.min_stacks > 0 || r.max_stacks < 10).length,
  vessels: input.enabled_vessels.length,
});

/** Describes a worker "error" event; browsers leave message empty when the script fails to load. */
function describeErrorEvent(e) {
  const where = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : "";
  return e.message ? `${e.message}${where}` : `worker stopped without a reason (event type "${e.type}")${where}`;
}

/** Fetches the worker's scripts to tell "can't load" apart from "crashed while running". */
async function probeScripts() {
  const out = {};
  for (const name of ["combo-worker.js", "combo-core.js", "game-data.js"]) {
    try {
      const res = await fetch(new URL(`./${name}`, import.meta.url), { cache: "no-store" });
      out[name] = `${res.status} ${res.headers.get("content-type") ?? "no content-type"}`;
    } catch (err) {
      out[name] = `fetch failed: ${err?.message ?? err}`;
    }
  }
  return out;
}

function runOnMainThread(input, options, started, workerError) {
  return new Promise((resolve, reject) => {
    // Let the page paint "Loading" first; the search blocks the UI while it runs
    setTimeout(() => {
      try {
        const res = runSearch(input, options);
        resolve({ ...res, ms: Math.round(performance.now() - started), mainThread: true, workerError });
      } catch (err) {
        lastDiagnostics.mainThreadError = { message: String(err?.message ?? err), stack: err?.stack };
        console.error("[Relic Vault] main-thread search failed too", err);
        reject(new Error(`${workerError}; main-thread fallback failed: ${err?.message ?? err}`));
      }
    }, 30);
  });
}

/** Resolves to { combinations, checked, ms }; rejects with SearchCancelled if superseded. */
export function searchCombos(input, options = {}) {
  cancelSearch();
  const vesselCount = input.enabled_vessels.length;
  if (vesselCount === 0) return Promise.resolve({ combinations: [], checked: 0, ms: 0 });
  const started = performance.now();
  lastDiagnostics = { at: new Date().toISOString(), poolSize: POOL_SIZE, input: inputStats(input), workersBroken };
  if (workersBroken) return runOnMainThread(input, options, started, workersBroken);

  try {
    pool = Array.from({ length: Math.min(POOL_SIZE, vesselCount) }, () => new Worker(WORKER_URL, { type: "module" }));
  } catch (err) {
    workersBroken = `could not create worker: ${err?.message ?? err}`;
    lastDiagnostics.workerError = workersBroken;
    console.error("[Relic Vault]", workersBroken, err);
    return runOnMainThread(input, options, started, workersBroken);
  }

  return new Promise((resolve, reject) => {
    const perVessel = new Array(vesselCount);
    let next = 0, done = 0;
    const settle = () => {
      rejectCurrent = null;
      for (const w of pool) w.terminate();
      pool = [];
    };
    const fail = (err) => {
      settle();
      reject(err);
    };
    // A worker died without telling us why: record everything we can, then retry on the main thread
    const fallBack = (detail) => {
      settle();
      workersBroken = detail;
      Object.assign(lastDiagnostics, { workerError: detail, completedVessels: done });
      console.error("[Relic Vault] combo worker failed; retrying on the main thread.", lastDiagnostics);
      probeScripts().then((probe) => { lastDiagnostics.scripts = probe; console.info("[Relic Vault] worker scripts:", probe); });
      runOnMainThread(input, options, started, detail).then(resolve, reject);
    };
    rejectCurrent = reject;

    const dispatch = (worker) => {
      if (next >= vesselCount) return;
      const v = next++;
      worker.postMessage({ id: v, input, vessels: [v], options });
    };
    for (const worker of pool) {
      worker.onmessage = ({ data }) => {
        if (rejectCurrent !== reject) return; // superseded
        if (data.error) {
          Object.assign(lastDiagnostics, { workerError: data.error, errorName: data.name, phase: data.phase, stack: data.stack });
          console.error(`[Relic Vault] combo worker ${data.phase} error:`, data.error, data.stack ?? "");
          // The engine itself threw: the main thread would hit the same error, so report it
          if (data.phase === "search") return fail(new Error(data.error));
          return fallBack(`could not load search engine in worker: ${data.error}`);
        }
        perVessel[data.id] = data.perVessel[0];
        if (++done === vesselCount) {
          rejectCurrent = null;
          resolve({ ...mergeResults(perVessel), ms: Math.round(performance.now() - started) });
        } else {
          dispatch(worker);
        }
      };
      worker.onmessageerror = () => {
        if (rejectCurrent === reject) fallBack("worker result could not be deserialized (messageerror)");
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        if (rejectCurrent === reject) fallBack(describeErrorEvent(e));
      };
      dispatch(worker);
    }
  });
}
