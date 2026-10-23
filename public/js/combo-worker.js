// Module worker: runs the combo search for a subset of vessels.
// The engine is imported dynamically so a failed load is reported with its real reason
// (a failed static import only gives the page an "error" event with no message).
const core = import("./combo-core.js");

const report = (id, err, phase) => self.postMessage({ id, error: String(err?.message ?? err), name: err?.name, stack: err?.stack, phase });

self.onmessage = async ({ data }) => {
  const { id, input, vessels, options } = data;
  let mod;
  try {
    mod = await core;
  } catch (err) {
    return report(id, err, "import");
  }
  try {
    const ctx = mod.prepareSearch(input, options);
    self.postMessage({ id, perVessel: mod.searchVessels(ctx, vessels) });
  } catch (err) {
    report(id, err, "search");
  }
};

self.addEventListener("unhandledrejection", (ev) => report(-1, ev.reason, "unhandled"));
