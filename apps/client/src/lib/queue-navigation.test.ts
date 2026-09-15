import { describe, expect, test } from "bun:test";
import { destinationQueueStartIndex, validatedQueueIndex } from "./queue-navigation";

const queue = [{ id: "first" }, { id: "second" }];

describe("destination queue navigation", () => {
  test("starts at rank one when nothing is playing", () => {
    expect(destinationQueueStartIndex(queue)).toBe(0);
  });

  test("an empty destination has no start position", () => {
    expect(destinationQueueStartIndex([])).toBe(-1);
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
