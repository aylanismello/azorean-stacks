/** One card on the board. Mirrors `public.lol_items`. */
export interface Item {
  id: string;
  title: string;
  detail: string | null;
  area: string;
  /** The list it sits in. "verified" is the one with meaning; every other value
   *  is just a list's name — see `VERIFIED` and `lanesOf`. */
  status: string;
  source: string | null;
  notes: string | null;
  sort: number;
  lane_sort: number;
  /// Where this has to be checked. More than one when the same code runs on both.
  devices: Device[];
  /// When the build carrying it was actually put on those devices — null means it
  /// is not testable yet, which is a different thing from untested.
  shipped_at: string | null;
  shipped_build: string | null;
  created_at: string;
  verified_at: string | null;
}

/**
 * **The only list whose name means something.** A card in `verified` has been
 * watched working by a person; the database stamps `verified_at` from this and
 * nothing else. Everything else on the board is a pile with a name on it —
 * "Built", or a batch of work with a date — and the board does not care what
 * they are called.
 */
export type Device = "iphone" | "ipad" | "mac";

/**
 * **Where a card has to be checked, and whether it is there yet.**
 *
 * Most of Mise is three apps over one codebase: a fix to the tape is a phone job,
 * a Rekordbox write-back can only be judged at the Mac. A board that says "go and
 * test this" without saying *on what* is a board you read twice.
 *
 * `devices` and `shipped_at` are deliberately separate. A card that needs the
 * iPhone and is not on the iPhone yet is not untested, it is **untestable** —
 * and a queue that cannot tell those apart is a queue full of things that might
 * be lies.
 */
export const DEVICES: { key: Device; label: string; glyph: string }[] = [
  { key: "iphone", label: "iPhone", glyph: "▯" },
  { key: "ipad", label: "iPad", glyph: "▭" },
  { key: "mac", label: "Mac", glyph: "▬" },
];
export function deviceLabel(d: Device): string {
  return DEVICES.find((x) => x.key === d)?.label ?? d;
}
/** Testable means the build is on the devices it names. Nothing to name, nothing to wait for. */
export function isTestable(i: Item): boolean {
  return i.devices.length === 0 || i.shipped_at !== null;
}

export const VERIFIED = "verified";
export const BUILT = "built";
/**
 * **Where a card goes when you looked and it was wrong.**
 *
 * Without it there are only two answers — checked, or not checked yet — and a
 * thing you tried that did not work has to pretend to be one of those. Left in
 * *built* it looks untouched and gets tested again; dragged to *verified* it is a
 * lie. Neither says the one thing worth saying, which is **you already spent the
 * trip and it failed**.
 *
 * So this column is not a third state of the work, it is a message: *come back to
 * this*. It sits between the two because that is the order it happens in, and
 * whatever you write in the card's note is the whole brief.
 */
export const LOOK_AGAIN = "look again";

export interface Lane {
  key: string;
  label: string;
  order: number;
  empty: string;
}

const LABELS: Record<string, string> = { built: "Built", "look again": "Look again", verified: "Verified" };
const EMPTY: Record<string, string> = {
  built: "Nothing waiting on you.",
  "look again": "Nothing kicked back.",
  verified: "Nothing checked off yet.",
};

/**
 * The lists to draw, in order, taken from the cards themselves — so a new batch
 * appears by inserting rows and never by shipping a build. `built` and
 * `verified` are always drawn even when empty, because an empty Verified column
 * is the most important thing the board can show you.
 */
export function lanesOf(items: Item[]): Lane[] {
  const seen = new Map<string, number>([
    [BUILT, 200],
    [LOOK_AGAIN, 250],
    [VERIFIED, 300],
  ]);
  for (const i of items) {
    if (!seen.has(i.status) || i.lane_sort < (seen.get(i.status) as number)) {
      seen.set(i.status, i.lane_sort);
    }
  }
  return [...seen.entries()]
    .map(([key, order]) => ({
      key,
      order,
      label: LABELS[key] ?? key,
      empty: EMPTY[key] ?? "Empty.",
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
