/**
 * **The board's own paint, owned nowhere else.**
 *
 * Every colour this sub-app uses is written here as a literal, not pulled from
 * the host application's theme tokens. That is deliberate and it is the whole
 * point of the folder: lifted into another repo tomorrow, this still looks like
 * itself, with no stylesheet to bring along and no tokens to go and define.
 *
 * The values are Trello's, near enough — a board is blue, a list is the grey
 * that makes a white card look raised, and the ink is dark navy rather than
 * black because black on white at this size reads as a wall of text.
 */
export const LOOK = {
  board: "#0079BF",
  list: "#F1F2F4",
  listInk: "#172B4D",
  card: "#FFFFFF",
  ink: "#172B4D",
  soft: "#5E6C84",
  line: "rgba(9,30,66,0.13)",
  accent: "#0C66E4",
  danger: "#C9372C",
} as const;

/** Trello's list is 272px and has been for a decade. It is the right width: a
 *  card title wraps to two lines and stops, so a column scans as a column. */
export const LIST_WIDTH = 272;

/**
 * **The area, as a colour.** A label is a colour first and a word second — after
 * a day on the board you stop reading the chip and recognise the stripe.
 *
 * The areas actually in use are named. Hashing them put four of the five real
 * ones on the same green: eight colours, nine areas, collisions landing wherever
 * the hash felt like. The hash is only the fallback for an area nobody has
 * invented yet.
 */
const PALETTE = ["#4BCE97", "#F5CD47", "#FEA362", "#F87168", "#9F8FEF", "#6CC3E0", "#94C748", "#E774BB"];
const KNOWN: Record<string, string> = {
  tape: "#6CC3E0",
  library: "#9F8FEF",
  records: "#F5CD47",
  rekordbox: "#F87168",
  sync: "#FEA362",
  build: "#4BCE97",
  tools: "#94C748",
  decisions: "#E774BB",
};
export function labelFor(area: string): string {
  const known = KNOWN[area.trim().toLowerCase()];
  if (known) return known;
  let h = 2166136261;
  for (const ch of area.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PALETTE[(h >>> 7) % PALETTE.length];
}

/**
 * **Always Pacific, wherever the browser thinks it is.** These stamps answer
 * "was that before or after I rebuilt it", and that question falls apart the
 * moment the clock moves under you between a phone and a Mac. `9:35PM 10/10/26`
 * — no seconds, because the minute is the resolution a person checks things at.
 */
const AT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const ON = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});
export function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Intl puts a space — often a narrow no-break one — before AM/PM; closed up here
  return `${AT.format(d).replace(/[\s  ]+/g, "")} ${ON.format(d)}`;
}
