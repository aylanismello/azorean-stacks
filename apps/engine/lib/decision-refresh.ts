export const EXPLICIT_DECISION_STATUSES = new Set([
  "approved",
  "rejected",
  "skipped",
  "listened",
]);

export function isExplicitDecision(status: unknown): boolean {
  return typeof status === "string" && EXPLICIT_DECISION_STATUSES.has(status);
}

export interface DecisionRefreshDependencies {
  refreshPersonalizedScores(userId: string): Promise<void>;
  materializeUserQueue(userId: string): Promise<unknown>;
}

/** Recompute the user's score snapshot before reading it into their queue. */
export async function refreshDecisionQueue(
  userId: string,
  dependencies: DecisionRefreshDependencies,
): Promise<void> {
  await dependencies.refreshPersonalizedScores(userId);
  await dependencies.materializeUserQueue(userId);
}
