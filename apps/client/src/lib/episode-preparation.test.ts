import { describe, expect, test } from "bun:test";
import {
  AcquisitionRequest,
  createPrepareEpisodeHandler,
  PrepareEpisodeDependencies,
} from "./episode-preparation";
import { MixPreparationEntry } from "./mix-series";

const context = { params: Promise.resolve({ id: "episode-1" }) };
const post = (body: unknown) => new Request("http://localhost/api/episodes/episode-1/prepare", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const entry = (position: number, trackId = `track-${position}`): MixPreparationEntry => ({
  position,
  track_id: trackId,
  tracks: {
    storage_path: null,
    youtube_url: `https://youtube.com/watch?v=canonical-${trackId}`,
    metadata: { soundcloud_url: "https://soundcloud.com/full-mix-must-not-be-used" },
  },
});

function harness(overrides: Partial<PrepareEpisodeDependencies> = {}) {
  const calls = {
    ownedSession: [] as unknown[],
    activeTrackIds: [] as string[][],
    acquisitionRequests: [] as AcquisitionRequest[],
    sessionUpdates: [] as unknown[],
    listedEpisodes: [] as string[],
  };
  const dependencies: PrepareEpisodeDependencies = {
    async getUserId() { return "owner-1"; },
    async findOwnedSession(input) {
      calls.ownedSession.push(input);
      return { id: "session-1", current_position: 4 };
    },
    async listEpisodeEntries(episodeId) {
      calls.listedEpisodes.push(episodeId);
      return [entry(0)];
    },
    async listActiveAcquisitionTrackIds(trackIds) {
      calls.activeTrackIds.push(trackIds);
      return [];
    },
    async insertAcquisitionRequests(requests) {
      calls.acquisitionRequests.push(...requests);
    },
    async updateOwnedSession(input) {
      calls.sessionUpdates.push(input);
    },
    now() { return new Date("2026-09-10T12:00:00.000Z"); },
    ...overrides,
  };
  return { calls, handler: createPrepareEpisodeHandler(dependencies) };
}

describe("episode preparation handler", () => {
  test("rejects unauthenticated requests before reading or writing episode state", async () => {
    const { handler, calls } = harness({ async getUserId() { return null; } });
    const response = await handler(post({ session_id: "session-1", current_position: 0 }), context);
    expect(response.status).toBe(401);
    expect(calls.ownedSession).toEqual([]);
    expect(calls.acquisitionRequests).toEqual([]);
    expect(calls.sessionUpdates).toEqual([]);
  });

  test("owner-scopes session lookup and update", async () => {
    const { handler, calls } = harness();
    const response = await handler(post({ session_id: "session-1", current_position: 0 }), context);
    expect(response.status).toBe(202);
    expect(calls.ownedSession).toEqual([{
      sessionId: "session-1", episodeId: "episode-1", userId: "owner-1",
    }]);
    expect(calls.sessionUpdates).toEqual([{
      sessionId: "session-1",
      userId: "owner-1",
      lastPosition: 4,
      currentPosition: 0,
      updatedAt: "2026-09-10T12:00:00.000Z",
    }]);
    expect(calls.acquisitionRequests[0].user_id).toBe("owner-1");
  });

  test("rejects a position absent from the episode without queue mutation", async () => {
    const { handler, calls } = harness({ async listEpisodeEntries() { return [entry(0), entry(2)]; } });
    const response = await handler(post({ session_id: "session-1", current_position: 1 }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "current_position does not exist in this episode" });
    expect(calls.activeTrackIds).toEqual([]);
    expect(calls.acquisitionRequests).toEqual([]);
    expect(calls.sessionUpdates).toEqual([]);
  });

  test("deduplicates canonical acquisition work but preserves repeated appearances in order", async () => {
    const repeatedFirst = entry(0, "repeat");
    const repeatedLater = entry(2, "repeat");
    repeatedLater.tracks!.youtube_url = "https://youtube.com/watch?v=must-not-win";
    const entries = [repeatedFirst, { position: 1, track_id: null, tracks: null }, repeatedLater, entry(3)];
    const { handler, calls } = harness({ async listEpisodeEntries() { return entries; } });

    const response = await handler(post({ session_id: "session-1", current_position: 0 }), context);
    const body = await response.json();
    expect(body.queued).toEqual([
      { position: 0, track_id: "repeat" },
      { position: 2, track_id: "repeat" },
      { position: 3, track_id: "track-3" },
    ]);
    expect(calls.activeTrackIds).toEqual([["repeat", "track-3"]]);
    expect(calls.acquisitionRequests).toEqual([
      {
        track_id: "repeat", user_id: "owner-1", status: "pending",
        youtube_url: "https://youtube.com/watch?v=canonical-repeat",
      },
      {
        track_id: "track-3", user_id: "owner-1", status: "pending",
        youtube_url: "https://youtube.com/watch?v=canonical-track-3",
      },
    ]);
  });

  test("uses only durable acquisition requests and leaves active canonical work untouched", async () => {
    const { handler, calls } = harness({
      async listEpisodeEntries() { return [entry(0), entry(1)]; },
      async listActiveAcquisitionTrackIds() { return ["track-0"]; },
    });
    const response = await handler(post({ session_id: "session-1", current_position: 0 }), context);
    expect(response.status).toBe(202);
    expect(calls.acquisitionRequests.map((request) => request.track_id)).toEqual(["track-1"]);
    // The preparation dependency surface has no FYP queue or user_tracks mutation.
    expect("audioPreparationQueue" in calls).toBe(false);
    expect("userTracks" in calls).toBe(false);
  });

  test("returns explicit arrays for ready, queued, and unavailable across current plus five later resolvable appearances", async () => {
    const ready = entry(0, "ready");
    ready.tracks!.storage_path = "owner/ready.mp3";
    const unavailable = entry(3, "unavailable");
    unavailable.tracks!.youtube_url = null;
    const entries = [
      ready,
      { position: 1, track_id: null, tracks: null },
      entry(2),
      unavailable,
      entry(4), entry(5), entry(6), entry(7), entry(8),
    ];
    const { handler } = harness({ async listEpisodeEntries() { return entries; } });
    const response = await handler(post({ session_id: "session-1", current_position: 0 }), context);
    const body = await response.json();

    expect(body).toEqual({
      session_id: "session-1",
      current_position: 0,
      ready: [{ position: 0, track_id: "ready" }],
      queued: [
        { position: 2, track_id: "track-2" },
        { position: 4, track_id: "track-4" },
        { position: 5, track_id: "track-5" },
        { position: 6, track_id: "track-6" },
      ],
      unavailable: [{ position: 3, track_id: "unavailable" }],
    });
  });
});
