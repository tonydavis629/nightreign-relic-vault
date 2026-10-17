import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RANK, MAX_RANK, rankOf, weightForRank } from "../public/js/priority.js";

test("12 ranks map to weights from x3 down to x0.25, strictly decreasing", () => {
  const w = Array.from({ length: MAX_RANK }, (_, i) => weightForRank(i + 1));
  assert.equal(w[0], 3);
  assert.equal(w[MAX_RANK - 1], 0.25);
  for (let i = 1; i < w.length; i++) assert.ok(w[i] < w[i - 1]);
});

test("old High / Normal / Low priorities keep their exact weights", () => {
  assert.equal(weightForRank(rankOf({ priority: "high" })), 2);
  assert.equal(weightForRank(rankOf({ priority: "normal" })), 1);
  assert.equal(weightForRank(rankOf({ priority: "low" })), 0.5);
  // settings saved before ranks existed only stored a weight
  assert.equal(rankOf({ weight: 2 }), 5);
  assert.equal(rankOf({ weight: 1 }), 9);
  assert.equal(rankOf({ weight: 0.5 }), 11);
});

test("ranks are clamped and default sensibly", () => {
  assert.equal(rankOf({ priority: 0 }), 1);
  assert.equal(rankOf({ priority: 99 }), MAX_RANK);
  assert.equal(rankOf({ rank: "4" }), 4);
  assert.equal(rankOf({}), DEFAULT_RANK);
  assert.equal(weightForRank(DEFAULT_RANK), 1);
});
