import { describe, expect, test } from "bun:test";
import {
  createEpisodeSessionPostHandler,
  EpisodeSessionDependencies,
  MixEpisodeSessionRecord,
} from "./episode-session";

const context = { params: Promise.resolve({ id: "episode-1" }) };
const post = (body: unknown) => new Request("http://localhost/api/episodes/episode-1/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function record(input: {
  userId: string;
  seriesId: string;
  episodeId: string;
  lastPosition: number;
  currentPosition: number;
  updatedAt: string;
}): MixEpisodeSessionRecord {
  return {
    id: "session-1",
    episode_id: input.episodeId,
    series_id: input.seriesId,
    last_position: input.lastPosition,
    current_position: input.currentPosition,
    state: "active",
    started_at: "2026-09-01T00:00:00.000Z",
    updated_at: input.updatedAt,
  };
}

function harness(overrides: Partial<EpisodeSessionDependencies> = {}) {
  const calls = {
    positions: [] as unknown[],
    ownedSessions: [] as unknown[],
    upserts: [] as unknown[],
  };
  const dependencies: EpisodeSessionDependencies = {
    async getUserId() { return "owner-1"; },
    async findEpisode() { return { id: "episode-1", series_id: "series-1", title: "Episode" }; },
    async episodePositionExists(input) { calls.positions.push(input); return true; },
    async findOwnedEpisodeSession(input) { calls.ownedSessions.push(input); return { current_position: 2 }; },
    async upsertOwnedEpisodeSession(input) { calls.upserts.push(input); return record(input); },
    now() { return new Date("2026-09-10T12:00:00.000Z"); },
    ...overrides,
  };
  return { calls, handler: createEpisodeSessionPostHandler(dependencies) };
}

describe("episode session POST handler", () => {
  test("rejects unauthenticated requests before episode or session access", async () => {
    let episodeRead = false;
    const { handler, calls } = harness({
      async getUserId() { return null; },
      async findEpisode() { episodeRead = true; return null; },
    });
    const response = await handler(post({ current_position: 0 }), context);
    expect(response.status).toBe(401);
    expect(episodeRead).toBe(false);
    expect(calls.upserts).toEqual([]);
  });

  test("rejects an out-of-range episode position before owner state is read or written", async () => {
    const { handler, calls } = harness({ async episodePositionExists(input) { calls.positions.push(input); return false; } });
    const response = await handler(post({ current_position: 99 }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "current_position does not exist in this episode" });
    expect(calls.positions).toEqual([{ episodeId: "episode-1", position: 99 }]);
    expect(calls.ownedSessions).toEqual([]);
    expect(calls.upserts).toEqual([]);
  });

  test("owner-scopes existing-state lookup and session upsert", async () => {
    const { handler, calls } = harness();
    const response = await handler(post({ current_position: 4 }), context);
    expect(response.status).toBe(201);
    expect(calls.ownedSessions).toEqual([{ episodeId: "episode-1", userId: "owner-1" }]);
    expect(calls.upserts).toEqual([{
      userId: "owner-1",
      seriesId: "series-1",
      episodeId: "episode-1",
      lastPosition: 2,
      currentPosition: 4,
      updatedAt: "2026-09-10T12:00:00.000Z",
    }]);
    expect(await response.json()).toEqual({ session: record(calls.upserts[0] as Parameters<typeof record>[0]) });
  });
});
