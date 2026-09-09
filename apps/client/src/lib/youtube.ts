/** Extract a video ID from common YouTube URLs. */
export function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") return null;
    if (parsed.searchParams.has("v")) return parsed.searchParams.get("v");
    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
    return pathMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

function openWebFallback(url: string): void {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
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

function preferYouTubeApp(videoId: string, webUrl: string): void {
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
    // A same-tab fallback remains allowed after the user gesture and cannot
    // leak a blank popup if the native app successfully takes focus.
    window.location.assign(webUrl);
  }, 900);

  window.location.assign(`vnd.youtube://${videoId}`);
}

/**
 * Prefer the YouTube app on iPhone/iPad. Desktop and Android continue to use
 * the HTTPS URL, avoiding custom-protocol behavior changes on those devices.
 */
export function openYouTube(url: string): void {
  const webUrl = httpsUrl(url);
  if (!webUrl) return;
  const videoId = extractVideoId(webUrl);
  const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (videoId && isiOS) {
    preferYouTubeApp(videoId, webUrl);
    return;
  }

  openWebFallback(webUrl);
}
