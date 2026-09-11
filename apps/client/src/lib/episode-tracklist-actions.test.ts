import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  canonicalEpisodeTracklistRowId,
  performEpisodeTracklistAction,
  type EpisodeTracklistAction,
} from "./episode-tracklist-actions";

const track = { id: "appearance-7", artist: "Artist", title: "Song" };

function response(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

describe("EpisodeTracklist actions", () => {
  test("the row context-menu path has no playback or repeat operations", () => {
    const component = readFileSync(
      new URL("../components/EpisodeTracklist.tsx", import.meta.url),
      "utf8",
    );
    const contextPath = component.slice(
      component.indexOf("const openContextMenu"),
      component.indexOf("const statusText"),
    );
    expect(contextPath).not.toContain("globalPlayer.play(");
    expect(contextPath).not.toContain("globalPlayer.loadTrack(");
    expect(contextPath).not.toContain("setQueue(");
    expect(contextPath).not.toContain("playFromQueue(");
    expect(contextPath).not.toContain("toggleRepeatTrack(");
  });

  test("only resolves canonical rows", () => {
    expect(canonicalEpisodeTracklistRowId({ id: "track-1", status: "pending" })).toBe("track-1");
    expect(canonicalEpisodeTracklistRowId({
      id: "track-2",
      appearance_id: "appearance-2",
      track: { id: "track-2" },
    })).toBe("track-2");
    expect(canonicalEpisodeTracklistRowId({
      id: "appearance-3",
      appearance_id: "appearance-3",
      status: "unresolved",
      track: null,
    })).toBeNull();
    expect(canonicalEpisodeTracklistRowId({
      id: "appearance-4",
      appearanceId: "appearance-4",
    })).toBeNull();
    expect(canonicalEpisodeTracklistRowId(
      { id: "appearance-5" },
      "canonical-5",
    )).toBe("canonical-5");
  });

  test.each([
    ["like", { status: "approved" }, { voteStatus: "approved", superLiked: false }],
    ["star", { super_liked: true }, { voteStatus: "approved", superLiked: true }],
    ["reject", { status: "rejected" }, { voteStatus: "rejected", superLiked: false }],
    ["skip", { status: "skipped" }, { voteStatus: "skipped", superLiked: false }],
    ["bad_source", { status: "bad_source" }, { voteStatus: "bad_source", superLiked: false }],
  ] as const)("sends a playback-neutral %s request", async (action, payload, expected) => {
    const fetcher = mock(async () => response());
    const playback = {
      play: mock(() => {}),
      loadTrack: mock(() => {}),
      setQueue: mock(() => {}),
      playFromQueue: mock(() => {}),
      next: mock(() => false),
    };

    const result = await performEpisodeTracklistAction(
      action as EpisodeTracklistAction,
      "canonical-42",
      track,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/tracks/canonical-42", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(result).toEqual(expected);
    for (const callback of Object.values(playback)) expect(callback).not.toHaveBeenCalled();
  });

  test("re-seeds the canonical track with ensure and no playback calls", async () => {
    const fetcher = mock(async () => response({ action: "created", seed_id: "seed-9" }));
    const play = mock(() => {});
    const loadTrack = mock(() => {});
    const changeQueue = mock(() => {});

    const result = await performEpisodeTracklistAction("reseed", "canonical-42", track, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/seeds/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_id: "canonical-42",
        artist: "Artist",
        title: "Song",
        action: "ensure",
      }),
    });
    expect(result).toEqual({ seedId: "seed-9" });
    expect(play).not.toHaveBeenCalled();
    expect(loadTrack).not.toHaveBeenCalled();
    expect(changeQueue).not.toHaveBeenCalled();
  });

  test("surfaces API errors", async () => {
    const fetcher = mock(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    }));

    await expect(
      performEpisodeTracklistAction("like", "canonical-42", track, fetcher),
    ).rejects.toThrow("Unauthorized");
  });
});
