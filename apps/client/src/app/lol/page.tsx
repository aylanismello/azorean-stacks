"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/**
 * /lol — the board between "I built it" and "I saw it work".
 *
 * Two columns and nothing in between, because there is nothing in between: a
 * thing is either a claim somebody made or a thing you have watched happen on
 * your own device. The second column is the only one that counts, and the only
 * way a card reaches it is a person moving it — nothing here ever promotes
 * itself, which is the whole point of the tool.
 *
 * **Two ways to move a card, because there are two ways this gets used.** At a
 * desk it drags, the way a board is supposed to: pick a card up, drop it in the
 * other column or further up its own. On a phone — which is where most of the
 * checking actually happens, one hand, standing over a device — HTML5 drag does
 * not exist, so the tick box on the left does the same job in one tap. Neither
 * is the "real" one.
 *
 * Cards group themselves by area so the board reads as a few short lists rather
 * than one long one, and the headings disappear as a column empties.
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

type Status = Item["status"];

const COLUMNS: { key: Status; label: string; empty: string }[] = [
  { key: "built", label: "Built", empty: "Nothing waiting on you." },
  { key: "verified", label: "Verified", empty: "Nothing checked off yet." },
];

export default function LolPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [addingTo, setAddingTo] = useState<Status | null>(null);
  const [draft, setDraft] = useState({ title: "", area: "", detail: "" });
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  // the last good board, so a refused move can be put back exactly as it was
  const rollback = useRef<Item[] | null>(null);

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

  const save = async (id: string, patch: Partial<Item>) => {
    try {
      const r = await fetch("/api/lol", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "That didn't stick");
      const { item } = await r.json();
      setItems((xs) => xs.map((x) => (x.id === item.id ? item : x)));
      setError(null);
    } catch (e) {
      if (rollback.current) setItems(rollback.current);
      setError(e instanceof Error ? e.message : "That didn't stick");
    } finally {
      rollback.current = null;
    }
  };

  // Moved on screen first, then on the server. A board you have to wait for is
  // a board you stop using mid-test, and the failure case is one refresh away.
  const move = (item: Item, status: Status, before?: Item) => {
    if (item.status === status && !before) return;
    rollback.current = items;

    const column = items
      .filter((x) => x.status === status && x.id !== item.id)
      .sort((a, b) => a.sort - b.sort);
    const at = before ? column.findIndex((x) => x.id === before.id) : column.length;
    const seat = at < 0 ? column.length : at;
    // sit it between its new neighbours; a plain average keeps every other
    // card's number untouched, so one drop is one row written
    const prev = seat === 0 ? (column[0]?.sort ?? 100) - 100 : column[seat - 1].sort;
    const next = seat >= column.length ? prev + 200 : column[seat].sort;
    const sort = Math.round((prev + next) / 2);

    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, status, sort } : x)));
    save(item.id, { status, sort });
  };

  const note = (item: Item, notes: string) => {
    if ((item.notes ?? "") === notes) return;
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...x, notes } : x)));
    save(item.id, { notes: notes || " " });
  };

  const add = async (status: Status) => {
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
      if (status === "verified") move(item, "verified");
      setDraft({ title: "", area: "", detail: "" });
      setAddingTo(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that");
    }
  };

  const grouped = useMemo(() => {
    const out: Record<Status, [string, Item[]][]> = { built: [], verified: [] };
    for (const col of COLUMNS) {
      const mine = items.filter((i) => i.status === col.key).sort((a, b) => a.sort - b.sort);
      const byArea = new Map<string, Item[]>();
      for (const i of mine) byArea.set(i.area, [...(byArea.get(i.area) ?? []), i]);
      out[col.key] = [...byArea.entries()];
    }
    return out;
  }, [items]);

  const total = (g: [string, Item[]][]) => g.reduce((n, [, xs]) => n + xs.length, 0);

  const card = (item: Item) => {
    const isOpen = open[item.id];
    const done = item.status === "verified";
    return (
      <div
        key={item.id}
        draggable
        onDragStart={(e) => {
          setDragId(item.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDragId(null);
          setOver(null);
        }}
        onDragOver={(e) => {
          if (!dragId || dragId === item.id) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(item.status);
        }}
        onDrop={(e) => {
          if (!dragId || dragId === item.id) return;
          e.preventDefault();
          e.stopPropagation();
          const moving = items.find((x) => x.id === dragId);
          if (moving) move(moving, item.status, item);
          setDragId(null);
          setOver(null);
        }}
        className={`cursor-grab rounded-lg bg-surface-3 p-2.5 shadow-sm ring-1 transition-all hover:ring-accent/40 active:cursor-grabbing ${
          dragId === item.id ? "opacity-40 ring-accent/60" : "ring-surface-4/50"
        }`}
      >
        <div className="flex items-start gap-2">
          <button
            onClick={() => move(item, done ? "built" : "verified")}
            aria-label={done ? "Send back to built" : "Mark verified"}
            className={`mt-0.5 h-4 w-4 shrink-0 rounded border transition-colors ${
              done ? "border-accent bg-accent text-surface-0" : "border-surface-4 hover:border-accent/60"
            }`}
          >
            {done ? <span className="block text-[10px] leading-4">✓</span> : null}
          </button>
          <button onClick={() => setOpen((o) => ({ ...o, [item.id]: !isOpen }))} className="min-w-0 flex-1 text-left">
            <p className={`text-sm leading-snug ${done ? "text-muted line-through" : "text-foreground"}`}>
              {item.title}
            </p>
            {/* the badge row: what this card is carrying, without opening it */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted/70">
              {item.detail ? <span title="has steps to check">☰</span> : null}
              {item.notes?.trim() ? <span title="you left a note">✎</span> : null}
              {item.verified_at ? (
                <span title="when you verified it">
                  ✓ {new Date(item.verified_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              ) : null}
              {item.source ? <span className="truncate">{item.source}</span> : null}
            </div>
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
          </div>
        ) : null}
      </div>
    );
  };

  const adder = (status: Status) =>
    addingTo === status ? (
      <div className="space-y-2 rounded-xl border border-surface-4/60 bg-surface-2 p-3">
        <input
          autoFocus
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && add(status)}
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
            onClick={() => add(status)}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 hover:bg-accent-bright"
          >
            Add
          </button>
          <button onClick={() => setAddingTo(null)} className="px-3 py-1.5 text-sm text-muted hover:text-foreground">
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <button
        onClick={() => {
          setDraft({ title: "", area: "", detail: "" });
          setAddingTo(status);
        }}
        className="w-full rounded-lg px-2 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-3/70 hover:text-foreground"
      >
        + Add a card
      </button>
    );

  return (
    // The board is a surface of its own, the way a Trello board is — the lists
    // sit *on* something rather than floating in the page.
    <div className="mx-auto max-w-5xl px-3 pb-24 pt-4 md:px-6 md:pt-8">
      <header className="mb-4 px-1">
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
        <div className="flex flex-col gap-3 rounded-2xl bg-surface-0/60 p-2 ring-1 ring-surface-4/30 md:flex-row md:items-start md:gap-3">
          {COLUMNS.map((col) => {
            const groups = grouped[col.key];
            return (
              <section
                key={col.key}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  setOver(col.key);
                }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const moving = items.find((x) => x.id === dragId);
                  if (moving) move(moving, col.key);
                  setDragId(null);
                  setOver(null);
                }}
                className={`min-w-0 flex-1 self-start rounded-xl bg-surface-1 p-2 ring-1 transition-colors ${
                  over === col.key && dragId ? "bg-accent/5 ring-accent/40" : "ring-surface-4/40"
                }`}
              >
                <div className="flex items-center justify-between px-2 pb-2 pt-1">
                  <h2 className="text-sm font-semibold text-foreground">{col.label}</h2>
                  <span className="font-mono text-xs text-muted/70">{total(groups)}</span>
                </div>

                {groups.length === 0 ? (
                  <p className="mx-1 mb-1 rounded-lg px-2 py-6 text-center text-xs text-muted">{col.empty}</p>
                ) : (
                  <div className="mb-1 space-y-4">
                    {groups.map(([area, xs]) => (
                      <div key={area}>
                        <h3 className="mb-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-accent/80">
                          {area} <span className="text-muted/60">· {xs.length}</span>
                        </h3>
                        <div className="space-y-2">{xs.map(card)}</div>
                      </div>
                    ))}
                  </div>
                )}

                {adder(col.key)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
