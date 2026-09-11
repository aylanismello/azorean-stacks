export async function refreshSeedOwnerQueue(
  userId: string | null | undefined,
  refresh: (ownerUserId: string) => Promise<void>,
  onError: (error: unknown) => void = () => {},
): Promise<boolean> {
  if (!userId) return false;

  try {
    await refresh(userId);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export interface SeedFypRefreshRecord {
  id: string;
  user_id?: string | null;
  pipeline_status?: Record<string, unknown> | null;
  fyp_refresh_required_at?: string | null;
  fyp_refreshed_at?: string | null;
}

/** User-owned seeds with explicit state are owned by the priority processor. */
export function isPriorityManagedSeed(
  seed: Pick<SeedFypRefreshRecord, "user_id" | "pipeline_status">,
): boolean {
  return Boolean(seed.user_id && typeof seed.pipeline_status?.state === "string");
}

/** From an oldest-first scan, recover only the latest legacy seed per user. */
export function latestStatelessUserSeeds<T extends Pick<SeedFypRefreshRecord, "user_id" | "pipeline_status">>(
  seeds: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const seed of seeds) {
    if (seed.user_id && !isPriorityManagedSeed(seed)) latest.set(seed.user_id, seed);
  }
  return [...latest.values()];
}

/** A durable marker makes one-shot fresh-seed promotion restart-safe. */
export function needsSeedFypRefresh(seed: SeedFypRefreshRecord): boolean {
  const status = seed.pipeline_status;
  return Boolean(
    seed.id
      && seed.user_id
      && status?.state === "done"
      && seed.fyp_refresh_required_at
      && !seed.fyp_refreshed_at,
  );
}

export async function recoverSeedFypRefreshes(
  seeds: SeedFypRefreshRecord[],
  claim: (seed: SeedFypRefreshRecord) => Promise<string | null>,
  refresh: (userId: string) => Promise<void>,
  checkpoint: (seed: SeedFypRefreshRecord, claimToken: string) => Promise<void>,
  release: (seed: SeedFypRefreshRecord, claimToken: string) => Promise<void>,
  onError: (seed: SeedFypRefreshRecord, error: unknown) => void = () => {},
): Promise<{ pending: number; claimed: number; recovered: number }> {
  const pending = seeds.filter(needsSeedFypRefresh);
  let claimed = 0;
  let recovered = 0;
  for (const seed of pending) {
    let claimToken: string | null = null;
    try {
      claimToken = await claim(seed);
      if (!claimToken) continue;
      claimed++;
      await refresh(seed.user_id!);
      await checkpoint(seed, claimToken);
      recovered++;
    } catch (error) {
      if (claimToken) {
        try {
          await release(seed, claimToken);
        } catch (releaseError) {
          onError(seed, releaseError);
        }
      }
      onError(seed, error);
    }
  }
  return { pending: pending.length, claimed, recovered };
}

/** Serialize queue read/upsert/retirement transactions within one worker process. */
export function createQueueMutationSerializer() {
  let chain: Promise<void> = Promise.resolve();
  return function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}
