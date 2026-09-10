const DEFAULT_POT_PROVIDER_URL = "http://127.0.0.1:4416";

export function downloadConcurrency(rawValue = process.env.DOWNLOAD_CONCURRENCY): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

export function isYouTubeUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

export function isSupportedAcquisitionUrl(rawUrl: string): boolean {
  if (isYouTubeUrl(rawUrl)) return true;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  } catch {
    return false;
  }
}

export function preferredAcquisitionUrl(
  requestedUrl: unknown,
  catalogYouTubeUrl: unknown,
): string | null {
  if (typeof requestedUrl === "string" && isSupportedAcquisitionUrl(requestedUrl)) return requestedUrl;
  if (typeof catalogYouTubeUrl === "string" && isYouTubeUrl(catalogYouTubeUrl)) return catalogYouTubeUrl;
  return null;
}

/**
 * Canonical audio acquisition arguments. Every worker uses this helper so a
 * YouTube extractor fix cannot silently land in only one of three download
 * paths again.
 */
export function ytDlpAudioArgs(url: string, outputTemplate: string): string[] {
  const args = [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", process.env.YT_DLP_AUDIO_QUALITY || "2",
    "--no-playlist",
    "--no-warnings",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    "--extractor-retries", "3",
  ];

  if (isYouTubeUrl(url)) {
    args.push(
      "--extractor-args", "youtube:player_client=mweb",
      "--extractor-args", `youtubepot-bgutilhttp:base_url=${process.env.YT_DLP_POT_PROVIDER_URL || DEFAULT_POT_PROVIDER_URL}`,
    );
  }

  args.push("-o", outputTemplate, url);
  return args;
}
