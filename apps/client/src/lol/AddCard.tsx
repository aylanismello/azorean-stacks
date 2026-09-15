"use client";

import { useState } from "react";
import { LOOK } from "./look";

/** The composer at the foot of a list. Collapsed it is one quiet line; open it
 *  asks the three things a card needs and nothing more. */
export function AddCard({ onAdd }: { onAdd: (draft: { title: string; area: string; detail: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", area: "", detail: "" });

  const field = {
    background: LOOK.card,
    border: `1px solid ${LOOK.line}`,
    color: LOOK.ink,
  } as const;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-black/5"
        style={{ color: LOOK.soft }}
      >
        <span className="text-base leading-none">+</span> Add a card
      </button>
    );
  }

  const submit = () => {
    if (!draft.title.trim()) return;
    onAdd(draft);
    setDraft({ title: "", area: "", detail: "" });
    setOpen(false);
  };

  return (
    <div className="space-y-2 rounded-lg p-2" style={{ background: LOOK.card, boxShadow: "0 1px 1px rgba(9,30,66,0.25)" }}>
      <input
        autoFocus
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="what needs checking"
        className="w-full rounded p-2 text-sm outline-none placeholder:opacity-60"
        style={field}
      />
      <input
        value={draft.area}
        onChange={(e) => setDraft({ ...draft, area: e.target.value })}
        placeholder="area (Tape, Sync, Rekordbox…)"
        className="w-full rounded p-2 text-sm outline-none placeholder:opacity-60"
        style={field}
      />
      <textarea
        value={draft.detail}
        onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
        placeholder="how to check it"
        rows={2}
        className="w-full resize-y rounded p-2 text-sm outline-none placeholder:opacity-60"
        style={field}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          className="rounded px-3 py-1.5 text-sm font-medium text-white"
          style={{ background: LOOK.accent }}
        >
          Add card
        </button>
        <button onClick={() => setOpen(false)} className="px-2 py-1.5 text-sm" style={{ color: LOOK.soft }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
