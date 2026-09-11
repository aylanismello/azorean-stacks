type OptionalExplorationLogger = (message: string, error: unknown) => void;

type OptionalExplorationAudioTrack = {
  storage_path?: string | null;
  audio_url?: string;
};

interface LoadFypWithOptionalExplorationOptions<OrdinaryTrack, ExplorationTrack> {
  loadPersonalized: () => Promise<OrdinaryTrack[]>;
  loadExploration: (ordinaryRows: OrdinaryTrack[]) => Promise<ExplorationTrack[]>;
  shouldExplore: boolean;
  logExplorationError?: OptionalExplorationLogger;
}

/**
 * Keep personalized 4U authoritative while treating series exploration as an
 * optional lane. Personalized errors still reject; exploration errors do not.
 */
export async function loadFypWithOptionalExploration<OrdinaryTrack, ExplorationTrack>({
  loadPersonalized,
  loadExploration,
  shouldExplore,
  logExplorationError = (message, error) => console.error(message, error),
}: LoadFypWithOptionalExplorationOptions<OrdinaryTrack, ExplorationTrack>) {
  const rows = await loadPersonalized();
  if (!shouldExplore) return { rows, seriesExploration: [] as ExplorationTrack[] };

  try {
    const seriesExploration = await loadExploration(rows);
    return { rows, seriesExploration };
  } catch (error) {
    logExplorationError("Failed to load optional series exploration", error);
    return { rows, seriesExploration: [] as ExplorationTrack[] };
  }
}

/** Sign optional exploration audio independently so one storage failure cannot fail the FYP. */
export async function signOptionalExplorationAudio<Track extends OptionalExplorationAudioTrack>(
  tracks: Track[],
  sign: (storagePath: string) => Promise<string | null>,
  logError: OptionalExplorationLogger = (message, error) => console.error(message, error),
): Promise<void> {
  await Promise.allSettled(tracks.map(async (track) => {
    if (!track.storage_path) return;
    try {
      const signedUrl = await sign(track.storage_path);
      if (signedUrl) track.audio_url = signedUrl;
      else delete track.audio_url;
    } catch (error) {
      delete track.audio_url;
      logError("Failed to sign optional series exploration audio", error);
    }
  }));
}
