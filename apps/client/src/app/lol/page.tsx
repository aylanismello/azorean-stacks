"use client";

import { useState, useEffect, useMemo, useCallback } from "react";

/**
 * /lol — the board between "I built it" and "I saw it work".
 *
 * Two columns and nothing in between, because there is nothing in between: a
 * thing is either a claim somebody made or a thing you have watched happen on
 * your own device. The second column is the only one that counts, and the only
 * way a card reaches it is a person pressing the button — nothing here ever
 * moves a card on its own, which is the whole point of the tool.
 *
 * Cards group themselves by area so the board reads as a few short lists rather
 * than one long one, and the group headings disappear when a column empties.
 */

interface Item {
  id: string;
  title: string;
  detail: string | null;
  area: string;
  source: string | null;
  status: "built" | "verified";
  notes: string | null;
  sort: number;
  created_at: string;
  verified_at: string | null;
}

export default function LolPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", area: "", detail: "" });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/lol");
      if (!r.ok) throw new Error((await r.json()).error ?? "Couldn't load the board");
      setItems((await r.json()).items as Item[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Moved on screen first, then on the server. A board you have to wait for is
  // a board you stop using mid-test, and the failure case is a reload away.
  const move = async (item: Item, status: Item["status"]) => {
    const before = items;
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, status } : x)));
    try {
      const r = await fetch("/api/lol", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "That didn't stick");
      const { item: saved } = await r.json();
      setItems((xs) => xs.map((x) => (x.id === saved.id ? saved : x)));
      setError(null);
    } catch (e) {
      setItems(before);
      setError(e instanceof Error ? e.message : "That didn't stick");
    }
  };

  const note = async (item: Item, notes: string) => {
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, notes } : x)));
    await fetch("/api/lol", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, notes: notes || " " }),
    }).catch(() => {});
  };

  const add = async () => {
    const title = draft.title.trim();
    if (!title) return;
    try {
      const r = await fetch("/api/lol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          area: draft.area.trim() || "General",
          detail: draft.detail.trim() || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Couldn't add that");
      const { item } = await r.json();
      setItems((xs) => [...xs, item]);
      setDraft({ title: "", area: "", detail: "" });
      setAdding(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that");
    }
  };

  const columns = useMemo(() => {
    const group = (status: Item["status"]) => {
      const mine = items.filter((i) => i.status === status);
      const byArea = new Map<string, Item[]>();
      for (const i of mine) byArea.set(i.area, [...(byArea.get(i.area) ?? []), i]);
      return [...byArea.entries()].sort((a, b) => b[1].length - a[1].length);
    };
    return { built: group("built"), verified: group("verified") };
  }, [items]);

  const count = (g: [string, Item[]][]) => g.reduce((n, [, xs]) => n + xs.length, 0);

  const card = (item: Item) => {
    const isOpen = open[item.id];
    const verified = item.status === "verified";
    return (
      <div
        key={item.id}
        className="rounded-xl border border-surface-4/60 bg-surface-2 p-3 transition-colors hover:border-accent/30"
      >
        <div className="flex items-start gap-2">
          <button
            onClick={() => move(item, verified ? "built" : "verified")}
            aria-label={verified ? "Send back to built" : "Mark verified"}
            className={`mt-0.5 h-5 w-5 shrink-0 rounded-md border transition-colors ${
              verified
                ? "border-accent bg-accent text-surface-0"
                : "border-surface-4 hover:border-accent/60"
            }`}
          >
            {verified ? <span className="block text-xs leading-5">✓</span> : null}
          </button>
          <button onClick={() => setOpen((o) => ({ ...o, [item.id]: !isOpen }))} className="min-w-0 flex-1 text-left">
            <p className={`text-sm leading-snug ${verified ? "text-muted line-through" : "text-foreground"}`}>
              {item.title}
            </p>
            {item.source ? <p className="mt-1 font-mono text-[10px] text-muted/70">{item.source}</p> : null}
          </button>
        </div>

        {isOpen ? (
          <div className="mt-3 space-y-3 border-t border-surface-4/50 pt-3">
            {item.detail ? <p className="text-xs leading-relaxed text-foreground/70">{item.detail}</p> : null}
            <textarea
              defaultValue={item.notes ?? ""}
              onBlur={(e) => note(item, e.target.value)}
              placeholder="what you found…"
              rows={2}
              className="w-full resize-y rounded-lg border border-surface-4/60 bg-surface-1 p-2 text-xs text-foreground placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
            />
            {item.verified_at ? (
              <p className="font-mono text-[10px] text-muted/70">
                verified {new Date(item.verified_at).toLocaleString()}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const column = (title: string, groups: [string, Item[]][], empty: string) => (
    <section className="min-w-0 flex-1">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
        <span className="font-mono text-xs text-muted/70">{count(groups)}</span>
      </div>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-surface-4/60 p-6 text-center text-xs text-muted">{empty}</p>
      ) : (
        <div className="space-y-5">
          {groups.map(([area, xs]) => (
            <div key={area}>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-accent/80">
                {area} <span className="text-muted/60">· {xs.length}</span>
              </h3>
              <div className="space-y-2">{xs.map(card)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-4 md:px-6 md:pt-8">
      <header className="mb-6">
        <h1 className="font-mono text-2xl text-foreground">/lol</h1>
        <p className="mt-1 text-sm text-muted">
          Built is a claim. Verified is you having watched it work. Only you move a card.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-400">{error}</div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-8 md:flex-row md:gap-6">
            {column("Built", columns.built, "Nothing waiting on you.")}
            {column("Verified", columns.verified, "Nothing checked off yet.")}
          </div>

          <div className="mt-10">
            {adding ? (
              <div className="space-y-2 rounded-xl border border-surface-4/60 bg-surface-2 p-3">
                <input
                  autoFocus
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  placeholder="what needs checking"
                  className="w-full rounded-lg border border-surface-4/60 bg-surface-1 p-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
                />
                <input
                  value={draft.area}
                  onChange={(e) => setDraft({ ...draft, area: e.target.value })}
                  placeholder="area (Tape, Sync, Rekordbox…)"
                  className="w-full rounded-lg border border-surface-4/60 bg-surface-1 p-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
                />
                <textarea
                  value={draft.detail}
                  onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
                  placeholder="how to check it"
                  rows={2}
                  className="w-full resize-y rounded-lg border border-surface-4/60 bg-surface-1 p-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={add}
                    className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 hover:bg-accent-bright"
                  >
                    Add
                  </button>
                  <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-muted hover:text-foreground">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="w-full rounded-xl border border-dashed border-surface-4/60 py-3 text-sm text-muted transition-colors hover:border-accent/40 hover:text-foreground"
              >
                + something to check
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
