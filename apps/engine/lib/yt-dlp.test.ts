import { describe, expect, test } from "bun:test";
import { downloadConcurrency, isYouTubeUrl, preferredAcquisitionUrl, ytDlpAudioArgs } from "./yt-dlp";

describe("downloadConcurrency", () => {
  test("uses a bounded default for missing or invalid configuration", () => {
    expect(downloadConcurrency(undefined)).toBe(4);
    expect(downloadConcurrency("garbage")).toBe(4);
    expect(downloadConcurrency("0")).toBe(4);
    expect(downloadConcurrency("6")).toBe(6);
  });
});

describe("ytDlpAudioArgs", () => {
  test("adds the verified YouTube client and proof-of-origin provider", () => {
    const args = ytDlpAudioArgs("https://www.youtube.com/watch?v=abc", "/tmp/out.%(ext)s");
    expect(args).toContain("youtube:player_client=mweb");
    expect(args.some((arg) => arg.startsWith("youtubepot-bgutilhttp:base_url="))).toBe(true);
    expect(args.slice(-3)).toEqual(["-o", "/tmp/out.%(ext)s", "https://www.youtube.com/watch?v=abc"]);
  });

  test("does not send YouTube-only extractor settings to other sources", () => {
    const args = ytDlpAudioArgs("https://soundcloud.com/artist/track", "/tmp/out.%(ext)s");
    expect(args.some((arg) => arg.includes("player_client"))).toBe(false);
    expect(args.some((arg) => arg.includes("youtubepot"))).toBe(false);
  });
});

describe("isYouTubeUrl", () => {
  test("accepts canonical and short YouTube hosts only", () => {
    expect(isYouTubeUrl("https://youtu.be/abc")).toBe(true);
    expect(isYouTubeUrl("https://music.youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com.evil.example/watch?v=abc")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});

describe("preferredAcquisitionUrl", () => {
  test("uses an explicit SoundCloud correction instead of the stale catalog YouTube URL", () => {
    expect(preferredAcquisitionUrl(
      "https://soundcloud.com/artist/correct-track",
      "https://www.youtube.com/watch?v=stale",
    )).toBe("https://soundcloud.com/artist/correct-track");
  });

  test("rejects lookalike hosts and falls back to the catalog source", () => {
    expect(preferredAcquisitionUrl(
      "https://evil.example/?next=soundcloud.com/artist/track",
      "https://youtu.be/catalog",
    )).toBe("https://youtu.be/catalog");
  });
});
