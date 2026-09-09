import { describe, expect, test } from "bun:test";
import { getFypKeyboardAction } from "./fyp-keyboard";

const key = (value: string, shiftKey = false) => ({
  key: value,
  shiftKey,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
});

describe("FYP keyboard shortcuts", () => {
  test("maps arrows and shifted arrows exactly", () => {
    expect(getFypKeyboardAction(key("ArrowRight"))).toBe("seek-forward");
    expect(getFypKeyboardAction(key("ArrowLeft"))).toBe("seek-backward");
    expect(getFypKeyboardAction(key("ArrowRight", true))).toBe("next-track");
    expect(getFypKeyboardAction(key("ArrowLeft", true))).toBe("previous-track");
  });

  test("maps decision keys", () => {
    expect(getFypKeyboardAction(key("x"))).toBe("reject");
    expect(getFypKeyboardAction(key("l"))).toBe("like");
    expect(getFypKeyboardAction(key("s"))).toBe("star");
    expect(getFypKeyboardAction(key("n"))).toBe("skip");
    expect(getFypKeyboardAction(key("r"))).toBe("reseed");
  });

  test("ignores modified and repeated keys", () => {
    expect(getFypKeyboardAction({ ...key("x"), metaKey: true })).toBeNull();
    expect(getFypKeyboardAction({ ...key("x"), repeat: true })).toBeNull();
  });
});
