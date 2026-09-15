/** One card on the board. Mirrors `public.lol_items`. */
export interface Item {
  id: string;
  title: string;
  detail: string | null;
  area: string;
  source: string | null;
  status: Status;
  notes: string | null;
  sort: number;
  created_at: string;
  verified_at: string | null;
}

export type Status = "built" | "verified";

export const COLUMNS: { key: Status; label: string; empty: string }[] = [
  { key: "built", label: "Built", empty: "Nothing waiting on you." },
  { key: "verified", label: "Verified", empty: "Nothing checked off yet." },
];
