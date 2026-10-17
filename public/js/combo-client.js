// Runs combo searches on a pool of workers (one vessel per task), mirroring upstream's
// rayon-parallel loop over vessels. Starting a new search cancels the previous one by
// terminating the pool, since a running search is synchronous inside its worker.
import { mergeResults } from "./combo-core.js";

const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
let pool = [];
let rejectCurrent = null;

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

/** Resolves to { combinations, checked, ms }; rejects with SearchCancelled if superseded. */
export function searchCombos(input, options = {}) {
  cancelSearch();
  const vesselCount = input.enabled_vessels.length;
  if (vesselCount === 0) return Promise.resolve({ combinations: [], checked: 0, ms: 0 });
  pool = Array.from({ length: Math.min(POOL_SIZE, vesselCount) }, () => new Worker(new URL("./combo-worker.js", import.meta.url), { type: "module" }));
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const perVessel = new Array(vesselCount);
    let next = 0, done = 0;
    const fail = (err) => {
      rejectCurrent = null;
      for (const w of pool) w.terminate();
      pool = [];
      reject(err);
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
        if (data.error) return fail(new Error(data.error));
        perVessel[data.id] = data.perVessel[0];
        if (++done === vesselCount) {
          rejectCurrent = null;
          resolve({ ...mergeResults(perVessel), ms: Math.round(performance.now() - started) });
        } else {
          dispatch(worker);
        }
      };
      worker.onerror = (e) => {
        if (rejectCurrent === reject) fail(new Error(e.message || "Combo worker failed"));
      };
      dispatch(worker);
    }
  });
}
