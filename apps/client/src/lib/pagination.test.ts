import { describe, expect, test } from "bun:test";
import { parsePagination } from "./pagination";

describe("parsePagination", () => {
  test("uses defaults", () => {
    expect(parsePagination(new URLSearchParams(), { defaultLimit: 20 })).toEqual({ limit: 20, offset: 0 });
  });

  test("clamps oversized limits", () => {
    expect(parsePagination(new URLSearchParams("limit=999&offset=4"), { defaultLimit: 20, maxLimit: 50 })).toEqual({
      limit: 50,
      offset: 4,
    });
  });

  for (const query of ["limit=0", "limit=-1", "limit=nope", "offset=-1", "offset=1.5"]) {
    test(`rejects invalid pagination: ${query}`, () => {
      expect(() => parsePagination(new URLSearchParams(query), { defaultLimit: 20 })).toThrow();
    });
  }
});
