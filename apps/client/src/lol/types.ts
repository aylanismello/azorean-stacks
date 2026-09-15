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
export const VERIFIED = "verified";
export const BUILT = "built";

export interface Lane {
  key: string;
  label: string;
  order: number;
  empty: string;
}

const LABELS: Record<string, string> = { built: "Built", verified: "Verified" };
const EMPTY: Record<string, string> = {
  built: "Nothing waiting on you.",
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
