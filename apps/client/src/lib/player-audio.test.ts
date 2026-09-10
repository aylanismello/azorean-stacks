import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PlayerTrack } from "@/components/GlobalPlayerProvider";
import { refreshSignedUrl } from "./player-audio";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("player signed audio refresh", () => {
  test("continues to the exact episode appearance fallback after an explicit endpoint failure", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/audio?")) return new Response("missing", { status: 404 });
      return Response.json([
        { id: "canonical-repeat", appearance_id: "appearance-other", audio_url: "wrong" },
        { id: "canonical-repeat", appearance_id: "appearance-target", audio_url: "fresh" },
      ]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const track = {
      id: "appearance-target", appearanceId: "appearance-target", catalogTrackId: "canonical-repeat",
      episodeId: "episode-1", audioRefreshUrl: "/api/episodes/episode-1/audio?session_id=session-1&appearance_id=appearance-target",
      artist: "A", title: "T", coverArtUrl: null, spotifyUrl: null, audioUrl: null,
    } satisfies PlayerTrack;

    expect(await refreshSignedUrl(track)).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/episodes/episode-1/tracks?session_id=session-1");
  });
});
