import { describe, expect, test } from "bun:test";
import { SOURCES } from "./index";

describe("generic discovery source registry", () => {
  test("does not include mix archives that have dedicated crawlers", () => {
    expect(SOURCES.map((source) => source.name)).not.toContain("soulection");
  });
});