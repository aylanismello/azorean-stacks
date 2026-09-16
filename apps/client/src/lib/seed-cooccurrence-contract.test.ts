import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const stackQueue = read("../app/api/stacks/[id]/queue/route.ts");
const stacks = read("../app/api/stacks/route.ts");
const fyp = read("../app/api/fyp/route.ts");
const personalization = read("./fyp-personalization.ts");
const seeds = read("../app/api/seeds/route.ts");
const algorithmStats = read("../app/api/stats/algorithm/route.ts");

describe("verified-episode co-occurrence contract", () => {
  test("seed stack playback admits every unconsumed appearance from a verified linked episode", () => {
    expect(stackQueue).toContain("!excludedIds.has(t.id)");
    expect(stackQueue).not.toContain("hasExactArtistCredits(t.artist, seed.artist)");
  });

  test("stack counts and filtered FYP use linked episode membership, not same-artist membership", () => {
    expect(stacks).toContain("linkedEpisodeIds.has(appearance.episode_id)");
    expect(stacks).toContain("for (const track of episodeTracks)");
    expect(personalization).toContain("allowedBySeed.add(link.track_id)");
    expect(personalization).not.toContain("hasExactArtistCredits(track.artist, ownedSeed.artist)");
    expect(personalization).toContain("seedId ? paceTracks(candidates) : candidates");
  });

  test("FYP attribution may name the qualifying seed for a co-occurring track", () => {
    expect(fyp).toContain("(lineageByEpisode.get(episodeId) || [])");
    expect(fyp).not.toContain("hasExactArtistCredits(track.artist, entry.seed.artist)");
  });

  test("seed counts and algorithm stats use canonical episode appearances", () => {
    expect(seeds).toContain("discovery_count: matchSummary.related_tracks");
    expect(seeds).not.toContain('.select("seed_track_id")');
    expect(algorithmStats).toContain('.from("episode_tracks")');
    expect(algorithmStats).not.toContain('.select("id, episode_id, artist")');
  });
});
