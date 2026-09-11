export interface SeekGeometry {
  left: number;
  width: number;
}

export interface SeekDrag {
  pointerId: number;
  position: number;
}

export function positionFromClientX(
  clientX: number,
  geometry: SeekGeometry,
  duration: number,
): number | null {
  if (duration <= 0 || geometry.width <= 0) return null;

  const fraction = Math.max(
    0,
    Math.min(1, (clientX - geometry.left) / geometry.width),
  );
  return fraction * duration;
}

export function beginSeekDrag(
  pointerId: number,
  clientX: number,
  geometry: SeekGeometry,
  duration: number,
): SeekDrag | null {
  const position = positionFromClientX(clientX, geometry, duration);
  return position === null ? null : { pointerId, position };
}

export function moveSeekDrag(
  drag: SeekDrag | null,
  pointerId: number,
  clientX: number,
  geometry: SeekGeometry,
  duration: number,
): SeekDrag | null {
  if (!drag || drag.pointerId !== pointerId) return drag;

  const position = positionFromClientX(clientX, geometry, duration);
  return position === null ? drag : { ...drag, position };
}

export function finishSeekDrag(
  drag: SeekDrag | null,
  pointerId: number,
): { drag: SeekDrag | null; commit: number | null } {
  if (!drag || drag.pointerId !== pointerId) {
    return { drag, commit: null };
  }

  return { drag: null, commit: drag.position };
}

export function cancelSeekDrag(
  drag: SeekDrag | null,
  pointerId: number,
): SeekDrag | null {
  if (!drag || drag.pointerId !== pointerId) return drag;
  return null;
}
