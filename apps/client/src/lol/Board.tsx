"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { COLUMNS, type Item, type Status } from "./types";
import { LOOK, LIST_WIDTH } from "./look";
import { listItems, patchItem, createItem, deleteItem } from "./api";
import { Card } from "./Card";
import { CardModal } from "./CardModal";
import { AddCard } from "./AddCard";

/**
 * /lol — the board between "I built it" and "I saw it work".
 *
 * Two columns and nothing in between, because there is nothing in between: a
 * thing is either a claim somebody made or a thing you have watched happen on
 * your own device. The second column is the only one that counts, and the only
 * way a card reaches it is a person moving it.
 *
 * **Lists are a fixed 272 points and the board is the room they stand in.** They
 * used to share the width, which stretched two lists across a monitor and made a
 * one-line card title a single long streak of text. A list is a column because
 * it is narrow; widen it and it stops scanning as one. The space left over is
 * the board, and a board is mostly empty — that is what it looks like.
 *
 * **Two ways to move a card, because there are two ways this gets used.** At a
 * desk it drags. On a phone — one hand, standing over a device — HTML5 drag does
 * not exist at all, so the tick box does the same job in one tap.
 */
export function Board() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  // the card the gap opens above — a board that only highlights the column
  // makes you guess where it will land, which is the whole feel of dragging
  const [overCard, setOverCard] = useState<string | null>(null);
  // the last good board, so a refused move can be put back exactly as it was
  const rollback = useRef<Item[] | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listItems());
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
      const saved = await patchItem(id, patch);
      setItems((xs) => xs.map((x) => (x.id === saved.id ? saved : x)));
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

  const remove = async (item: Item) => {
    const before = items;
    setItems((xs) => xs.filter((x) => x.id !== item.id));
    setOpenId(null);
    try {
      await deleteItem(item.id);
    } catch (e) {
      setItems(before);
      setError(e instanceof Error ? e.message : "Couldn't delete that");
    }
  };

  const add = async (status: Status, draft: { title: string; area: string; detail: string }) => {
    try {
      const item = await createItem({
        title: draft.title,
        area: draft.area.trim() || "General",
        detail: draft.detail.trim() || undefined,
      });
      setItems((xs) => [...xs, item]);
      if (status === "verified") move(item, "verified");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that");
    }
  };

  /**
   * One list per column, not a list of lists. The area used to be a heading with
   * its own cards under it, which is a second hierarchy on a board whose whole
   * argument is that there are only two places a thing can be. The colour on the
   * card says the area now, and the order stays the one you dragged.
   */
  const columns = useMemo(() => {
    const out: Record<Status, Item[]> = { built: [], verified: [] };
    for (const col of COLUMNS) {
      out[col.key] = items.filter((i) => i.status === col.key).sort((a, b) => a.sort - b.sort);
    }
    return out;
  }, [items]);

  const opened = openId ? items.find((x) => x.id === openId) ?? null : null;

  return (
    <div className="flex h-dvh flex-col" style={{ background: LOOK.board }}>
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <h1 className="font-mono text-lg font-semibold text-white">/lol</h1>
        <p className="text-sm text-white/70">
          Built is a claim. Verified is you having watched it work. Only you move a card.
        </p>
        {/* the one door back, because nothing else on this page leads anywhere */}
        <a href="/" className="ml-auto font-mono text-xs text-white/60 transition-colors hover:text-white">
          the stacks ↗
        </a>
      </header>

      {error ? (
        <div className="mx-4 mb-2 shrink-0 rounded-lg px-3 py-2 text-sm text-white" style={{ background: LOOK.danger }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-4">
          {COLUMNS.map((col) => {
            const cards = columns[col.key];
            return (
              <section
                key={col.key}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  setOver(col.key);
                }}
                onDragLeave={() => {
                  setOver((o) => (o === col.key ? null : o));
                  setOverCard(null);
                }}
                onDrop={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const moving = items.find((x) => x.id === dragId);
                  if (moving) move(moving, col.key);
                  setDragId(null);
                  setOver(null);
                  setOverCard(null);
                }}
                className="flex max-h-full shrink-0 flex-col rounded-xl p-2"
                style={{
                  width: LIST_WIDTH,
                  background: LOOK.list,
                  outline: over === col.key && dragId ? `2px solid ${LOOK.accent}` : "none",
                }}
              >
                <div className="flex shrink-0 items-center justify-between px-2 pb-2 pt-1">
                  <h2 className="text-sm font-semibold" style={{ color: LOOK.listInk }}>
                    {col.label}
                  </h2>
                  <span className="font-mono text-[11px]" style={{ color: LOOK.soft }}>
                    {cards.length}
                  </span>
                </div>

                {/* the cards scroll, the list header and its footer do not */}
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {cards.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs" style={{ color: LOOK.soft }}>
                      {col.empty}
                    </p>
                  ) : (
                    cards.map((item) => (
                      <Card
                        key={item.id}
                        item={item}
                        dragging={dragId === item.id}
                        showGapAbove={!!dragId && dragId !== item.id && overCard === item.id}
                        onOpen={() => setOpenId(item.id)}
                        onToggle={(to) => move(item, to)}
                        onDragStart={() => setDragId(item.id)}
                        onDragEnd={() => {
                          setDragId(null);
                          setOver(null);
                          setOverCard(null);
                        }}
                        onDragOverCard={() => {
                          setOver(item.status);
                          setOverCard(item.id);
                        }}
                        onDropOnCard={() => {
                          const moving = items.find((x) => x.id === dragId);
                          if (moving) move(moving, item.status, item);
                          setDragId(null);
                          setOver(null);
                          setOverCard(null);
                        }}
                      />
                    ))
                  )}
                </div>

                <div className="shrink-0 pt-1">
                  <AddCard onAdd={(draft) => add(col.key, draft)} />
                </div>
              </section>
            );
          })}
        </div>
      )}

      {opened ? (
        <CardModal
          item={opened}
          onClose={() => setOpenId(null)}
          onMove={() => {
            move(opened, opened.status === "verified" ? "built" : "verified");
            setOpenId(null);
          }}
          onNote={(notes) => note(opened, notes)}
          onDelete={() => remove(opened)}
        />
      ) : null}
    </div>
  );
}
