import { describe, expect, test } from "bun:test";
import type { EpisodeAppearance } from "@/app/mixes/types";
import {
  buildEpisodeQueue,
  nextEpisodePositionToPrepare,
  preparationCount,
  preparationEntries,
} from "./episode-playback";

function appearance(
  appearanceId: string,
  position: number,
  catalogTrackId: string | null,
): EpisodeAppearance {
  return {
    id: catalogTrackId || appearanceId,
    appearance_id: appearanceId,
    position,
    timestamp_text: null,
    source_artist: `Source ${position}`,
    source_title: `Title ${position}`,
    resolution_state: catalogTrackId ? "resolved" : "unresolved",
    artist: catalogTrackId ? `Artist ${position}` : null,
    title: catalogTrackId ? `Track ${position}` : null,
    spotify_url: null,
    youtube_url: null,
    cover_art_url: null,
    preview_url: null,
    audio_url: catalogTrackId ? `https://audio/${appearanceId}` : null,
    audio_status: catalogTrackId ? "ready" : "pending",
    storage_path: null,
    track: catalogTrackId ? {
      id: catalogTrackId,
      artist: `Artist ${position}`,
      title: `Track ${position}`,
      spotify_url: null,
      youtube_url: null,
      cover_art_url: null,
      preview_url: null,
      audio_url: `https://audio/${appearanceId}`,
      storage_path: null,
    } : null,
  };
}

describe("episode playback queue", () => {
  test("preserves exact order, repeated appearances, and unresolved positions", () => {
    const queue = buildEpisodeQueue([
      appearance("appearance-3", 2, "canonical-repeat"),
      appearance("appearance-1", 0, "canonical-repeat"),
      appearance("appearance-2", 1, null),
    ], { episodeId: "episode", sessionId: "session", episodeTitle: "Episode", seriesTitle: "Series" });

    expect(queue.map((track) => track.id)).toEqual([
      "appearance-1",
      "appearance-2",
      "appearance-3",
    ]);
    expect(queue.map((track) => track.catalogTrackId)).toEqual([
      "canonical-repeat",
      null,
      "canonical-repeat",
    ]);
    expect(queue.map((track) => track.episodePosition)).toEqual([0, 1, 2]);
    expect(queue[1].episodeAvailability).toBe("unresolved");
    expect(queue[1].audioRefreshUrl).toBeNull();
    expect(queue[0].audioRefreshUrl).toBe("/api/episodes/episode/audio?session_id=session&appearance_id=appearance-1");
  });

  test("normalizes legacy arrays and count plus entries prepare responses", () => {
    const entries = [{ position: 4, track_id: "track" }];
    expect(preparationEntries(entries)).toEqual(entries);
    expect(preparationCount(entries)).toBe(1);
    expect(preparationEntries({ count: 3, entries })).toEqual(entries);
    expect(preparationCount({ count: 3, entries })).toBe(3);
  });

  test("schedules rolling lookahead only when the appearance position advances", () => {
    const queue = buildEpisodeQueue([
      appearance("first", 3, "track-a"),
      appearance("second", 7, null),
    ], { episodeId: "episode", sessionId: "session", episodeTitle: null, seriesTitle: "Series" });

    expect(nextEpisodePositionToPrepare(queue, 0, null)).toBe(3);
    expect(nextEpisodePositionToPrepare(queue, 0, 3)).toBeNull();
    expect(nextEpisodePositionToPrepare(queue, 1, 3)).toBe(7);
    expect(nextEpisodePositionToPrepare(queue, 2, 7)).toBeNull();
  });
});
