// Effect priority ranks for the Combo Finder: 1 = most important ... 12 = least.
// Each rank is a step of 0.25 in scoring weight, from ×3 (rank 1) down to ×0.25 (rank 12).
// The old High / Normal / Low levels land exactly on ranks 5 / 9 / 11 (×2 / ×1 / ×0.5).

export const MAX_RANK = 12;
export const DEFAULT_RANK = 9;
const LEGACY = { high: 5, normal: 9, low: 11 };

export const weightForRank = (rank) => 3 - (clampRank(rank) - 1) * 0.25;

export function clampRank(rank) {
  const n = Math.round(Number(rank));
  return Number.isFinite(n) ? Math.min(MAX_RANK, Math.max(1, n)) : DEFAULT_RANK;
}

/** Rank for a stored entry or preset value: a number 1-12, "high"/"normal"/"low", or a legacy weight. */
export function rankOf({ rank, priority, weight } = {}) {
  if (rank !== undefined) return clampRank(rank);
  if (typeof priority === "number") return clampRank(priority);
  if (typeof priority === "string" && LEGACY[priority]) return LEGACY[priority];
  if (typeof weight === "number") return clampRank(1 + (3 - weight) / 0.25);
  return DEFAULT_RANK;
}

export function rankLabel(rank) {
  if (rank === 1) return "1 · top";
  if (rank === MAX_RANK) return `${MAX_RANK} · lowest`;
  return String(rank);
}

/** Points lost for each copy of an avoided effect: half its rank's weight (rank 1 -1.5 ... rank 9 -0.5 ... rank 12 -0.125). */
export const avoidPenaltyForRank = (rank) => weightForRank(rank) / 2;

/** Scoring weight of a wanted effect. Required effects (at least one stack) score like rank 1. */
export const wantedWeight = (entry) => (entry.minStacks > 0 ? weightForRank(1) : weightForRank(entry.rank));
