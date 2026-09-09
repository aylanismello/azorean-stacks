import { describe, expect, test } from "bun:test";
import { getSeedBadge } from "./seed-badge";

describe("seed badge classification", () => {
  test("shows explicit seeds and re-seeds", () => {
    expect(getSeedBadge({ is_seed: true })).toBe("seed");
    expect(getSeedBadge({ is_re_seed: true })).toBe("re-seed");
  });

  test("explicit seed wins over re-seed", () => {
    expect(getSeedBadge({ is_seed: true, is_re_seed: true })).toBe("seed");
  });

  test("does not present an artist-match flag as a seed", () => {
    expect(getSeedBadge({ is_artist_seed: true })).toBeNull();
    expect(getSeedBadge({})).toBeNull();
  });
});
