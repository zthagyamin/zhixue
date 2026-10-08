import type { PlanCandidate } from "./daily-plan";

// v0.8: candidate-vs-current diff for the approval UI.

export type PlanItem = PlanCandidate["items"][number];

export type PlanDiff = {
  added: PlanItem[];
  removed: PlanItem[];
};

export function planDiff(candidate: PlanCandidate, current: PlanCandidate | null): PlanDiff {
  const currentKeys = new Set((current?.items ?? []).map((item) => item.itemKey));
  const candidateKeys = new Set(candidate.items.map((item) => item.itemKey));
  return {
    added: candidate.items
      .filter((item) => !currentKeys.has(item.itemKey))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
    removed: (current?.items ?? [])
      .filter((item) => !candidateKeys.has(item.itemKey))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
  };
}
