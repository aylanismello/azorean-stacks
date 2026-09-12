export interface FypGeneration {
  generation: number;
  reason: "ranking_refresh" | "seed_refresh";
  seed_id: string | null;
  updated_at: string | null;
}

export interface FypMutationSummary {
  added: number;
  moved: number;
  changedIds: string[];
}

export function shouldApplyFypGeneration(lastGeneration: number, nextGeneration: number): boolean {
  return Number.isFinite(nextGeneration) && nextGeneration > lastGeneration;
}

export function describeFypMutation(previousIds: string[], nextIds: string[]): FypMutationSummary {
  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);
  const addedIds = nextIds.filter((id) => !previousSet.has(id));
  // Inserting one row shifts every later index, but those rows did not really
  // move relative to each other. Animate only retained rows whose order changed.
  const retainedBefore = previousIds.filter((id) => nextSet.has(id));
  const retainedAfter = nextIds.filter((id) => previousSet.has(id));
  const movedIds = retainedAfter.filter((id, index) => retainedBefore[index] !== id);
  return {
    added: addedIds.length,
    moved: movedIds.length,
    changedIds: Array.from(new Set([...addedIds, ...movedIds])),
  };
}

/** Keep the loaded row at its current index until playback moves on, even if
 * the latest materialized queue retires or reorders it. */
export function reconcileLiveFypQueue<T extends { id: string }>(
  previousQueue: T[],
  authoritativeQueue: T[],
  currentTrackId: string | null | undefined,
): T[] {
  if (!currentTrackId) return authoritativeQueue;
  const previousIndex = previousQueue.findIndex((track) => track.id === currentTrackId);
  if (previousIndex < 0) return authoritativeQueue;
  const authoritativeIndex = authoritativeQueue.findIndex((track) => track.id === currentTrackId);
  if (authoritativeIndex === previousIndex) return authoritativeQueue;

  const reconciled = authoritativeQueue.filter((track) => track.id !== currentTrackId);
  const authoritativeById = new Map(reconciled.map((track) => [track.id, track]));
  const before = previousQueue
    .slice(0, previousIndex)
    .map((track) => authoritativeById.get(track.id))
    .filter((track): track is T => Boolean(track));
  const beforeIds = new Set(before.map((track) => track.id));
  const after = reconciled.filter((track) => !beforeIds.has(track.id));
  return [...before, previousQueue[previousIndex], ...after];
}

export function fypGrowthLabel(summary: FypMutationSummary, reason: FypGeneration["reason"]): string {
  if (summary.added > 0) {
    return `4U grew ${summary.added} new branch${summary.added === 1 ? "" : "es"}`;
  }
  if (summary.moved > 0) {
    return `4U bent ${summary.moved} branch${summary.moved === 1 ? "" : "es"}`;
  }
  return reason === "seed_refresh" ? "4U followed the new direction" : "4U kept growing";
}
