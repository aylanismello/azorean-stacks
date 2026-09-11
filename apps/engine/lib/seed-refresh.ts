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

/** Serialize queue read/upsert/retirement transactions within one worker process. */
export function createQueueMutationSerializer() {
  let chain: Promise<void> = Promise.resolve();
  return function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}
