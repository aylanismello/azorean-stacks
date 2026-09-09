import { describe, expect, test } from "bun:test";
import {
  detectMusicPlatform,
  episodeTrackDedupeKey,
  fetchWithValidatedRedirects,
  isPublicIpAddress,
  normalizeEmbedIdentity,
  normalizeMusicUrl,
} from "./segundo-sol";

describe("Segundo Sol music links", () => {
  test("classifies supported music hosts", () => {
    expect(detectMusicPlatform("https://open.spotify.com/track/abc")).toBe("spotify");
    expect(detectMusicPlatform("https://soundcloud.com/artist/mix")).toBe("soundcloud");
    expect(detectMusicPlatform("https://artist.bandcamp.com/track/song")).toBe("bandcamp");
    expect(detectMusicPlatform("https://youtu.be/abc")).toBe("youtube");
    expect(detectMusicPlatform("https://www.mixcloud.com/dj/set/")).toBe("mixcloud");
  });

  test("rejects arbitrary and unsafe URLs", () => {
    expect(normalizeMusicUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeMusicUrl("http://127.0.0.1/private")).toBeNull();
    expect(normalizeMusicUrl("http://open.spotify.com/track/abc")).toBeNull();
    expect(normalizeMusicUrl("https://example.com/song")).toBeNull();
  });

  test("rejects private addresses and redirect-based SSRF", async () => {
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);

    const fetchImpl = async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/private" },
    });
    const lookupImpl = async () => [{ address: "8.8.8.8", family: 4 }];

    await expect(fetchWithValidatedRedirects(
      "https://open.spotify.com/track/abc",
      {},
      { fetchImpl, lookupImpl }
    )).rejects.toThrow("Unsafe metadata URL");
  });

  test("removes share tracking parameters", () => {
    expect(normalizeMusicUrl("https://open.spotify.com/track/abc?si=secret&utm_source=x")).toBe(
      "https://open.spotify.com/track/abc"
    );
  });

  test("normalizes provider titles into editable identity", () => {
    expect(normalizeEmbedIdentity("spotify", "A Calf Born in Winter - song by Khruangbin", "Spotify")).toEqual({
      title: "A Calf Born in Winter",
      creator: "Khruangbin",
    });
    expect(normalizeEmbedIdentity("bandcamp", "Azores, by A.F.M", "Bandcamp")).toEqual({
      title: "Azores",
      creator: "A.F.M",
    });
    expect(normalizeEmbedIdentity(
      "spotify",
      "Peach",
      "https://open.spotify.com/artist/example",
      "salute, Sammy Virji · Peach · Song · 2023"
    )).toEqual({ title: "Peach", creator: "salute, Sammy Virji" });
  });

  test("deduplicates catalog and normalized manual sources", () => {
    expect(episodeTrackDedupeKey({ track_id: "track-1" })).toBe("track:track-1");
    expect(
      episodeTrackDedupeKey({ source_url: "https://youtu.be/abc?si=share-token" })
    ).toBe("url:https://youtu.be/abc");
  });
});
