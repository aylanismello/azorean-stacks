import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  loadFypWithOptionalExploration,
  signOptionalExplorationAudio,
} from "./fyp-with-optional-exploration";

const fypRoute = readFileSync(new URL("../app/api/fyp/route.ts", import.meta.url), "utf8");

describe("loadFypWithOptionalExploration", () => {
  test("fails open when only optional exploration fails", async () => {
    const ordinaryRows = [{ id: "ordinary-1" }];
    const explorationError = new Error("Soulection unavailable");
    const logged: Array<[string, unknown]> = [];

    const result = await loadFypWithOptionalExploration({
      loadPersonalized: async () => ordinaryRows,
      loadExploration: async () => {
        throw explorationError;
      },
      shouldExplore: true,
      logExplorationError: (message, error) => logged.push([message, error]),
    });

    expect(result).toEqual({ rows: ordinaryRows, seriesExploration: [] });
    expect(logged).toEqual([["Failed to load optional series exploration", explorationError]]);
  });

  test("still rejects ordinary personalized 4U failures", async () => {
    const personalizedError = new Error("personalized FYP unavailable");
    let explorationCalled = false;
    const logged: Array<[string, unknown]> = [];

    const promise = loadFypWithOptionalExploration({
      loadPersonalized: async () => {
        throw personalizedError;
      },
      loadExploration: async () => {
        explorationCalled = true;
        return [{ id: "explore-1" }];
      },
      shouldExplore: true,
      logExplorationError: (message, error) => logged.push([message, error]),
    });

    await expect(promise).rejects.toBe(personalizedError);
    expect(explorationCalled).toBe(false);
    expect(logged).toEqual([]);
  });

  test("does not run exploration outside its eligible lane", async () => {
    const ordinaryRows = [{ id: "ordinary-1" }];
    let explorationCalled = false;

    const result = await loadFypWithOptionalExploration({
      loadPersonalized: async () => ordinaryRows,
      loadExploration: async () => {
        explorationCalled = true;
        return [{ id: "explore-1" }];
      },
      shouldExplore: false,
    });

    expect(result).toEqual({ rows: ordinaryRows, seriesExploration: [] });
    expect(explorationCalled).toBe(false);
  });
});

describe("signOptionalExplorationAudio", () => {
  test("fails open per exploration row while preserving successful signing", async () => {
    const failed = new Error("storage signer unavailable");
    const rows: Array<{
      id: string;
      storage_path: string | null;
      audio_url?: string;
      preview_url?: string;
    }> = [
      { id: "signed", storage_path: "audio/signed.mp3" },
      { id: "failed", storage_path: "audio/failed.mp3", audio_url: "https://stale.test/audio" },
      { id: "preview-only", storage_path: null, preview_url: "https://preview.test/audio" },
    ];
    const logged: Array<[string, unknown]> = [];

    await signOptionalExplorationAudio(
      rows,
      async (storagePath) => {
        if (storagePath === "audio/failed.mp3") throw failed;
        return `https://signed.test/${storagePath}`;
      },
      (message, error) => logged.push([message, error]),
    );

    expect(rows[0].audio_url).toBe("https://signed.test/audio/signed.mp3");
    expect(rows[1]).not.toHaveProperty("audio_url");
    expect(rows[2]).not.toHaveProperty("audio_url");
    expect(logged).toEqual([["Failed to sign optional series exploration audio", failed]]);
  });
});

describe("FYP route auth contract", () => {
  test("authenticates before loading either personalized or optional rows", () => {
    const authGate = fypRoute.indexOf("if (!user)");
    const feedLoad = fypRoute.indexOf("loadFypWithOptionalExploration({");

    expect(authGate).toBeGreaterThan(-1);
    expect(feedLoad).toBeGreaterThan(authGate);
  });

  test("routes optional exploration signing through fail-open handling", () => {
    expect(fypRoute).toContain("signOptionalExplorationAudio(seriesExploration");
  });
});
