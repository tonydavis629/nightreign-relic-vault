// Module worker: runs the combo search for a subset of vessels.
import { prepareSearch, searchVessels } from "./combo-core.js";

self.onmessage = ({ data }) => {
  const { id, input, vessels, options } = data;
  try {
    const ctx = prepareSearch(input, options);
    self.postMessage({ id, perVessel: searchVessels(ctx, vessels) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
