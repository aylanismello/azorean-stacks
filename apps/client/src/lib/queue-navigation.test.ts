import { describe, expect, test } from "bun:test";
import { destinationQueueStartIndex, validatedQueueIndex } from "./queue-navigation";

const queue = [{ id: "first" }, { id: "second" }];

describe("destination queue navigation", () => {
  test("starts at rank one when nothing is playing", () => {
    expect(destinationQueueStartIndex(queue, null)).toBe(0);
  });

  test("keeps a playing destination track at its real rank", () => {
    expect(destinationQueueStartIndex(queue, "second")).toBe(1);
  });

  test("keeps foreign playback outside the destination queue", () => {
    expect(destinationQueueStartIndex(queue, "other-stack-track")).toBe(-1);
  });
});

describe("validatedQueueIndex", () => {
  test("preserves a matching index", () => {
    expect(validatedQueueIndex(queue, 1, "second")).toBe(1);
  });

  test("normalizes stale and foreign positions", () => {
    expect(validatedQueueIndex(queue, 1, "first")).toBe(-1);
    expect(validatedQueueIndex(queue, 5, "first")).toBe(-1);
    expect(validatedQueueIndex(queue, 0, "other-stack-track")).toBe(-1);
  });
});
