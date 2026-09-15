import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const fypRoute = readFileSync(new URL("../app/api/fyp/route.ts", import.meta.url), "utf8");
const fypPage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const genresRoute = readFileSync(new URL("../app/api/genres/route.ts", import.meta.url), "utf8");
const stacksRoute = readFileSync(new URL("../app/api/stacks/route.ts", import.meta.url), "utf8");
const seedsRoute = readFileSync(new URL("../app/api/seeds/route.ts", import.meta.url), "utf8");

 describe("bespoke feed delivery contract", () => {
  test("filtered FYP requests warm their own candidates and expose readiness identities", () => {
    expect(fypRoute).toContain("loadPersonalizedFeed(db, user.id");
    expect(fypRoute).toContain("queueFilteredFeedPreparation(db, user.id, feed.candidates)");
    expect(fypRoute).toContain("preparing_track_ids: preparingTrackIds");
  });

  test("genre and seed cards count the same personalized candidates as playback", () => {
    expect(genresRoute).toContain("getPersonalizedCandidateTracks");
    expect(genresRoute).toContain("eligible: count.eligible");
    expect(stacksRoute).toContain("eligible_queue_tracks: feedCount.eligible");
    expect(stacksRoute).toContain('.eq("user_id", user.id)');
    expect(stacksRoute).not.toContain("user_id.is.null");
    expect(seedsRoute).toContain("eligible_for_you: feedCount.eligible");
  });

  test("a selected feed replaces stale playback and reconciles prepared audio live", () => {
    expect(fypPage).toContain("globalPlayer.loadTrack(playerTracks[startIndex])");
    expect(fypPage).toContain("!playerCurrentTrackRef.current && reconciledQueue[0]");
    expect(fypPage).toContain("globalPlayer.loadTrack(reconciledQueue[0])");
    expect(fypPage).toContain("globalPlayer.stop()");
    expect(fypPage).not.toContain('sessionStorage.getItem("stacks-active-queue-view")');
    expect(fypPage).not.toContain('sessionStorage.setItem("stacks-active-queue-view"');
    expect(fypPage).toContain('fetchTracks("navigation", controller.signal)');
    expect(fypPage).toContain("return () => controller.abort()");
    expect(fypPage).toContain("table: \"tracks\"");
    expect(fypPage).toContain("preparingTrackFilter");
    expect(fypPage).toContain('reconcile("readiness")');
    expect(fypPage).not.toContain("if (!isHomeFyp) return;\n    const supabase = createBrowserClient()");
  });

  test("stack counts include every episode used by seed playback", () => {
    expect(stacksRoute).toContain("const linkedEpisodes = episodesBySeed[seed.id] || []");
    expect(stacksRoute).toContain("linkedEpisodes.map((episode) => episode.id)");
  });
});
