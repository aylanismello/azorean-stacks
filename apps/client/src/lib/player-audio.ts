import type { PlayerTrack } from "@/components/GlobalPlayerProvider";

/** Fetch a fresh signed URL, continuing to the episode fallback if an explicit endpoint fails. */
export async function refreshSignedUrl(track: PlayerTrack): Promise<string | null> {
  if (track.audioRefreshUrl) {
    try {
      const response = await fetch(track.audioRefreshUrl);
      if (response.ok) {
        const data = await response.json() as { url?: string };
        if (data.url) return data.url;
      }
    } catch {}
  }
  if (!track.episodeId) return null;
  try {
    const fallback = new URL(`/api/episodes/${track.episodeId}/tracks`, "http://player.local");
    if (track.audioRefreshUrl) {
      const sessionId = new URL(track.audioRefreshUrl, "http://player.local").searchParams.get("session_id");
      if (sessionId) fallback.searchParams.set("session_id", sessionId);
    }
    const response = await fetch(`${fallback.pathname}${fallback.search}`);
    if (!response.ok) return null;
    const tracks: Array<{ id: string; appearance_id?: string; audio_url?: string }> = await response.json();
    const match = track.appearanceId
      ? tracks.find((candidate) => candidate.appearance_id === track.appearanceId)
      : tracks.find((candidate) => candidate.id === (track.catalogTrackId ?? track.id));
    return match?.audio_url || null;
  } catch {
    return null;
  }
}
