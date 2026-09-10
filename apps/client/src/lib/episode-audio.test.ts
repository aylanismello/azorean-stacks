import { describe, expect, test } from "bun:test";
import { createEpisodeAudioHandler, type EpisodeAudioDependencies } from "./episode-audio";

const context = { params: Promise.resolve({ id: "episode-1" }) };

function dependencies(overrides: Partial<EpisodeAudioDependencies> = {}): EpisodeAudioDependencies {
  return {
    getUserId: async () => "user-1",
    findOwnedSession: async ({ sessionId, episodeId, userId }) => sessionId === "session-1" && episodeId === "episode-1" && userId === "user-1" ? { id: sessionId } : null,
    findEpisodeAppearance: async ({ appearanceId, episodeId }) => appearanceId === "appearance-1" && episodeId === "episode-1" ? { storagePath: "episode/audio.mp3" } : null,
    createSignedUrl: async (path) => `signed:${path}`,
    ...overrides,
  };
}

describe("episode-owned audio refresh", () => {
  test("signs only an exact appearance in the authenticated user's episode session", async () => {
    const handler = createEpisodeAudioHandler(dependencies());
    const response = await handler(new Request("http://local/api/episodes/episode-1/audio?session_id=session-1&appearance_id=appearance-1"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "signed:episode/audio.mp3" });
  });

  test("rejects another session and never reaches appearance lookup", async () => {
    let appearanceLookups = 0;
    const handler = createEpisodeAudioHandler(dependencies({
      findOwnedSession: async () => null,
      findEpisodeAppearance: async () => { appearanceLookups++; return { storagePath: "secret" }; },
    }));
    const response = await handler(new Request("http://local/api/episodes/episode-1/audio?session_id=other&appearance_id=appearance-1"), context);
    expect(response.status).toBe(404);
    expect(appearanceLookups).toBe(0);
  });

  test("rejects an appearance outside the episode", async () => {
    const handler = createEpisodeAudioHandler(dependencies());
    const response = await handler(new Request("http://local/api/episodes/episode-1/audio?session_id=session-1&appearance_id=appearance-2"), context);
    expect(response.status).toBe(404);
  });
});
