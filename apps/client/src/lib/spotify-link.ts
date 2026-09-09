/**
 * Open external music links without leaving orphaned popup tabs.
 * Native protocols must be triggered synchronously from the click handler.
 */

function openWebFallback(url: string): void {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  // Popup blockers can still reject a user-initiated new tab. In that case,
  // preserve a reliable path by navigating the current tab.
  if (!opened) window.location.assign(url);
}

function httpsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return null;
  }
}

function preferNative(appUrl: string, webUrl: string): void {
  let finished = false;
  let fallbackTimer: ReturnType<typeof setTimeout>;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fallbackTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("blur", cleanup);
    window.removeEventListener("pagehide", cleanup);
  };
  const onVisibilityChange = () => {
    if (document.hidden) cleanup();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("blur", cleanup, { once: true });
  window.addEventListener("pagehide", cleanup, { once: true });
  fallbackTimer = setTimeout(() => {
    if (finished) return;
    cleanup();
    // Use this same browsing context: a delayed window.open is commonly
    // blocked and can leave a blank tab behind when the app opens.
    window.location.assign(webUrl);
  }, 900);

  window.location.assign(appUrl);
}

/** Extract a Spotify track ID from an open.spotify.com track URL. */
export function extractSpotifyTrackId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "open.spotify.com") return null;
    const match = parsed.pathname.match(/^\/(?:intl-[^/]+\/)?track\/([a-zA-Z0-9]+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Prefer the Spotify app on macOS and mobile devices, with HTTPS fallback.
 * Other desktop platforms keep the normal web behavior.
 */
export function openSpotify(url: string): void {
  const webUrl = httpsUrl(url);
  if (!webUrl) return;
  const trackId = extractSpotifyTrackId(webUrl);
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  if (trackId && (isMac || isMobile)) {
    preferNative(`spotify:track:${trackId}`, webUrl);
    return;
  }

  openWebFallback(webUrl);
}
