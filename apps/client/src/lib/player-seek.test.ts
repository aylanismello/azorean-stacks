import { describe, expect, test } from "bun:test";
import {
  beginSeekDrag,
  cancelSeekDrag,
  finishSeekDrag,
  moveSeekDrag,
  positionFromClientX,
} from "./player-seek";

describe("player seek dragging", () => {
  const geometry = { left: 100, width: 200 };

  test("maps pointer coordinates to clamped playback positions", () => {
    expect(positionFromClientX(100, geometry, 120)).toBe(0);
    expect(positionFromClientX(200, geometry, 120)).toBe(60);
    expect(positionFromClientX(400, geometry, 120)).toBe(120);
    expect(positionFromClientX(200, { left: 100, width: 0 }, 120)).toBeNull();
  });

  test("moves only the preview and yields one release commit", () => {
    let drag = beginSeekDrag(7, 150, geometry, 120);
    expect(drag?.position).toBe(30);

    drag = moveSeekDrag(drag, 7, 250, geometry, 120);
    expect(drag?.position).toBe(90);

    const released = finishSeekDrag(drag, 7);
    expect(released).toEqual({ drag: null, commit: 90 });

    const duplicateRelease = finishSeekDrag(released.drag, 7);
    expect(duplicateRelease).toEqual({ drag: null, commit: null });
  });

  test("ignores events from a different pointer", () => {
    const drag = beginSeekDrag(7, 150, geometry, 120);
    expect(moveSeekDrag(drag, 8, 250, geometry, 120)).toEqual(drag);
    expect(finishSeekDrag(drag, 8)).toEqual({ drag, commit: null });
  });

  test("cancels a drag without committing its preview", () => {
    const drag = beginSeekDrag(7, 250, geometry, 120);
    expect(cancelSeekDrag(drag, 8)).toEqual(drag);
    expect(cancelSeekDrag(drag, 7)).toBeNull();
  });
});
