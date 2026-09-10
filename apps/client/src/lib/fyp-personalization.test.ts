import { describe, expect, test } from "bun:test";
import { loadPersonalizedFyp } from "./fyp-personalization";

type Fixture = {
  pending?: Array<{ track_id: string; status: string }>;
  ready?: any[];
  scores?: any[];
  rankedScores?: any[];
};

function fixtureDb(fixture: Fixture) {
  const calls: Array<{ table: string; filters: Array<[string, unknown, unknown?]>; select?: string }> = [];
  let rpcCalls = 0;

  class Query {
    private filters: Array<[string, unknown, unknown?]> = [];
    private columns = "";
    constructor(private table: string) {}
    select(columns: string) { this.columns = columns; return this; }
    eq(column: string, value: unknown) { this.filters.push(["eq", column, value]); return this; }
    gt(column: string, value: unknown) { this.filters.push(["gt", column, value]); return this; }
    not(column: string, operator: unknown, value: unknown) { this.filters.push(["not", column, `${operator}:${value}`]); return this; }
    in(column: string, value: unknown) { this.filters.push(["in", column, value]); return this; }
    order(column: string) { this.filters.push(["order", column]); return this; }
    range(from: number, to: number) { this.filters.push(["range", from, to]); return this; }
    maybeSingle() { return this; }
    then(resolve: (value: { data: any[] | any | null; error: null }) => unknown) {
      calls.push({ table: this.table, filters: this.filters, select: this.columns });
      let data: any[] | any | null = [];
      if (this.table === "user_tracks") data = fixture.pending || [];
      if (this.table === "audio_preparation_queue") data = fixture.ready || [];
      if (this.table === "user_track_scores") {
        data = this.columns.includes("track:tracks") ? fixture.rankedScores || [] : fixture.scores || [];
      }
      return Promise.resolve(resolve({ data, error: null }));
    }
  }

  const db = {
    from(table: string) { return new Query(table); },
    rpc() { rpcCalls++; throw new Error("global RPC must not be called"); },
  };
  return { db, calls, get rpcCalls() { return rpcCalls; } };
}

const readyTrack = {
  id: "track-1",
  artist: "Artist",
  title: "Title",
  status: "rejected",
  storage_path: "audio/track-1.mp3",
  metadata: { genres: ["House"] },
};

describe("loadPersonalizedFyp", () => {
  test("global track status cannot suppress the user's pending ready candidate and confidence is personalized", async () => {
    const fixture = fixtureDb({
      pending: [{ track_id: "track-1", status: "pending" }],
      ready: [{ track_id: "track-1", rank: 1, track: readyTrack }],
      scores: [{ track_id: "track-1", score: 0.91, confidence: 0.87, components: { artist: 0.7 } }],
    });

    const rows = await loadPersonalizedFyp(fixture.db, "user-a", {
      limit: 20, offset: 0, hideLow: false,
    });

    expect(rows.map((track) => track.id)).toEqual(["track-1"]);
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].taste_score).toBe(0.91);
    expect(rows[0].metadata._score_confidence).toBe(0.87);
    expect(fixture.calls.some((call) => call.filters.some((filter) => filter[1] === "track.status"))).toBe(false);
  });

  test("missing personalized scores fail closed in unfiltered and filtered views", async () => {
    for (const genre of [null, "House"]) {
      const fixture = fixtureDb({
        pending: [{ track_id: "track-1", status: "pending" }],
        ready: [{ track_id: "track-1", rank: 1, track: readyTrack }],
        scores: [],
        rankedScores: [],
      });
      const rows = await loadPersonalizedFyp(fixture.db, "user-a", {
        limit: 20, offset: 0, hideLow: false, genre,
      });
      expect(rows).toEqual([]);
    }
  });

  test("never invokes the weak global FYP RPC for filtered or unfiltered loads", async () => {
    for (const genre of [null, "House"]) {
      const fixture = fixtureDb({ pending: [] });
      await loadPersonalizedFyp(fixture.db, "user-a", {
        limit: 20, offset: 0, hideLow: false, genre,
      });
      expect(fixture.rpcCalls).toBe(0);
    }
  });
});
