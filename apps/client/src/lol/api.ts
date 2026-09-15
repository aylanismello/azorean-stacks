import type { Item } from "./types";

/**
 * **Every call the board makes, in one place.** The components never touch
 * `fetch` — so moving this sub-app onto another backend is editing this file and
 * nothing else.
 */
const BASE = "/api/lol";

async function unwrap<T>(r: Response, fallback: string): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error ?? fallback);
  }
  return r.json();
}

export async function listItems(): Promise<Item[]> {
  const { items } = await unwrap<{ items: Item[] }>(await fetch(BASE), "Couldn't load the board");
  return items;
}

export async function patchItem(id: string, patch: Partial<Item>): Promise<Item> {
  const r = await fetch(BASE, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  const { item } = await unwrap<{ item: Item }>(r, "That didn't stick");
  return item;
}

export async function createItem(input: {
  title: string;
  area?: string;
  detail?: string;
  status?: string;
}): Promise<Item> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { item } = await unwrap<{ item: Item }>(r, "Couldn't add that");
  return item;
}

export async function deleteItem(id: string): Promise<void> {
  const r = await fetch(`${BASE}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  await unwrap<{ ok: true }>(r, "Couldn't delete that");
}
