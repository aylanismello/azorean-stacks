export type FypKeyboardAction =
  | "seek-backward"
  | "seek-forward"
  | "next-track"
  | "previous-track"
  | "reject"
  | "like"
  | "star"
  | "skip"
  | "reseed";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "repeat"
>;

export function getFypKeyboardAction(event: ShortcutEvent): FypKeyboardAction | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;

  if (event.shiftKey && event.key === "ArrowRight") return "next-track";
  if (event.shiftKey && event.key === "ArrowLeft") return "previous-track";
  if (event.shiftKey) return null;

  // This direction is intentional and follows the FYP control contract.
  if (event.key === "ArrowRight") return "seek-backward";
  if (event.key === "ArrowLeft") return "seek-forward";

  switch (event.key.toLowerCase()) {
    case "x": return "reject";
    case "l": return "like";
    case "s": return "star";
    case "n": return "skip";
    case "r": return "reseed";
    default: return null;
  }
}
