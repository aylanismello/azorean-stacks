import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  boundedSoulectionEpisodeLimit,
  extractPublicCatalogConfig,
  parseSoulectionEpisode,
  parseSoulectionIndex,
  soulectionSummaryFromRow,
} from "./soulection";

const fixture: string = readFileSync(new URL("./fixtures/soulection-744.html", import.meta.url), "utf8");

describe("Soulection source parser", () => {
  test("defaults the bounded recent archive to 22 episodes and caps it at 100", () => {
    expect(boundedSoulectionEpisodeLimit()).toBe(22);
    expect(boundedSoulectionEpisodeLimit(101)).toBe(100);
  });

  test("uses the maintained default for non-finite episode limits", () => {
    expect(boundedSoulectionEpisodeLimit(Number.NaN)).toBe(22);
    expect(boundedSoulectionEpisodeLimit(Number.POSITIVE_INFINITY)).toBe(22);
    expect(boundedSoulectionEpisodeLimit(Number.NEGATIVE_INFINITY)).toBe(22);
  });

  test("preserves episode metadata, timestamps, voiceovers, and repeated songs", () => {
    const episode = parseSoulectionEpisode(fixture, "7892c3b0-1cee-4f7c-bf9e-749d53a37a6a");
    expect(episode.title).toBe("Soulection Radio #744 (HARUNA Takeover)");
    expect(episode.dj).toEqual({ id: "6e29f6da-f4ba-4b30-8f82-70324e165450", name: "HARUNA" });
    expect(episode.artworkUrl).toBe("https://i1.sndcdn.com/episode.jpg");
    expect(episode.soundcloudUrl).toBe("https://soundcloud.com/soulection/show-744");
    expect(episode.appleMusicUrl).toContain("music.apple.com");
    expect(episode.rows.map((row) => row.timestamp)).toEqual(["00:00:23", "00:14:59", "01:13:42", "01:14:40"]);
    expect(episode.rows[1]).toMatchObject({ artist: "VO - HARUNA", title: null, songId: null });
    expect(episode.rows[2].songId).toBe(episode.rows[3].songId);
    expect(episode.rows[2].position).not.toBe(episode.rows[3].position);
  });

  test("extracts recent cards once and ignores featured duplicates", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const html = `<a href="/episodes/${first}"><img src="a.jpg"></a><li><a href="/episodes/${first}"><h2>Episode 2</h2><p>Desc<span>DJ One</span></p><img src="a.jpg"></a></li><li><a href="/episodes/${second}"><h2>Episode 1</h2></a></li>`;
    expect(parseSoulectionIndex(html)).toEqual([
      { id: first, url: `https://radio.soulection.com/episodes/${first}`, title: "Episode 2", description: "Desc", djName: "DJ One", artworkUrl: "a.jpg" },
      { id: second, url: `https://radio.soulection.com/episodes/${second}`, title: "Episode 1", description: null, djName: null, artworkUrl: null },
    ]);
  });

  test("discovers public catalog config without exposing it", () => {
    const publicKey = `${"eyJ" + "a".repeat(30)}.${"x".repeat(80)}.${"s".repeat(20)}`;
    const config = extractPublicCatalogConfig(`const u="https://abc.supabase.co",k="${publicKey}"`);
    expect(config?.url).toBe("https://abc.supabase.co");
    expect(config?.key.startsWith("eyJ")).toBe(true);
  });

  test("maps the catalog's SoundCloud artwork field", () => {
    expect(soulectionSummaryFromRow({
      id: "7892c3b0-1cee-4f7c-bf9e-749d53a37a6a",
      title: "Soulection Radio #744",
      soundcloud_artwork_url: "https://i1.sndcdn.com/artwork.jpg",
      djs: { name: "HARUNA" },
    })).toMatchObject({ artworkUrl: "https://i1.sndcdn.com/artwork.jpg", djName: "HARUNA" });
  });
});
