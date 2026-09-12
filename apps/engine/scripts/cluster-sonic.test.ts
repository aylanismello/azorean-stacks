import { describe, expect, test } from "bun:test";
import { deterministicKMeans, parsePgVector } from "./cluster-sonic";

describe("sonic clustering", () => {
  test("parses PostgREST pgvector values", () => {
    expect(parsePgVector("[0.25,-0.5,1]")).toEqual([0.25, -0.5, 1]);
    expect(parsePgVector([1, "2"])).toEqual([1, 2]);
    expect(() => parsePgVector("not-a-vector")).toThrow("Invalid pgvector");
    expect(() => parsePgVector([Number.NaN])).toThrow("Invalid pgvector");
  });

  test("separates deterministic compact groups", () => {
    const points = [
      { id: "a", vector: [0, 0] },
      { id: "b", vector: [0.1, 0] },
      { id: "c", vector: [10, 10] },
      { id: "d", vector: [10.1, 10] },
    ];
    const first = deterministicKMeans(points, 2);
    const second = deterministicKMeans(points, 2);
    expect(first).toEqual(second);
    expect(first[0]).toBe(first[1]);
    expect(first[2]).toBe(first[3]);
    expect(first[0]).not.toBe(first[2]);
  });

  test("rejects invalid cluster inputs", () => {
    expect(() => deterministicKMeans([{ id: "a", vector: [0] }], Number.NaN)).toThrow("Cluster count");
    expect(() => deterministicKMeans([{ id: "a", vector: [Number.NaN] }], 1)).toThrow("finite dimensions");
  });
});
