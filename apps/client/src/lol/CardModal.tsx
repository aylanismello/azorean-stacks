"use client";

import { useEffect } from "react";
import { VERIFIED, LOOK_AGAIN, BUILT, deviceLabel, isTestable, type Item } from "./types";
import { LOOK, labelFor, stamp } from "./look";

/**
 * A card, opened. Everything it is and the two things you can do to it.
 *
 * A dialog rather than an unfolding card: expanding in place pushes the rest of
 * the column down, so on a list of seventeen the thing you just tapped walks off
 * the screen. This holds still. Escape closes it, so does the backdrop, and on a
 * phone it rises from the bottom where a thumb already is.
 */
export function CardModal({
  item,
  onClose,
  onMove,
  onSendTo,
  onNote,
  onDelete,
}: {
  item: Item;
  onClose: () => void;
  onMove: () => void;
  onSendTo: (lane: string) => void;
  onNote: (notes: string) => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const done = item.status === VERIFIED;
  const waiting = !isTestable(item);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center md:p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl p-4 shadow-2xl md:rounded-xl md:p-5"
        style={{ background: LOOK.list, color: LOOK.ink }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="h-2 w-10 rounded" style={{ background: labelFor(item.area) }} />
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: LOOK.soft }}>
                {item.area}
              </span>
            </div>
            <h2 className="text-base font-semibold leading-snug">{item.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {item.devices.map((d) => (
                <span
                  key={d}
                  className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide"
                  style={
                    waiting
                      ? { color: LOOK.soft, border: `1px dashed ${LOOK.line}` }
                      : { color: "#fff", background: LOOK.listInk }
                  }
                >
                  {deviceLabel(d)}
                </span>
              ))}
              {waiting ? (
                <span className="font-mono text-[11px]" style={{ color: LOOK.danger }}>
                  the build carrying this is not on {item.devices.length === 1 ? "it" : "them"} yet
                </span>
              ) : null}
            </div>
            {item.source ? (
              <p className="mt-1 font-mono text-[11px]" style={{ color: LOOK.soft }}>
                {item.source}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded px-2 py-1 text-lg leading-none hover:bg-black/5"
            style={{ color: LOOK.soft }}
          >
            ×
          </button>
        </div>

        {item.detail ? (
          <section className="mb-4">
            <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider" style={{ color: LOOK.soft }}>
              How to check it
            </h3>
            <p
              className="whitespace-pre-wrap rounded-lg p-3 text-sm leading-relaxed"
              style={{ background: LOOK.card, boxShadow: "0 1px 1px rgba(9,30,66,0.2)" }}
            >
              {item.detail}
            </p>
          </section>
        ) : null}

        <section className="mb-4">
          <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider" style={{ color: LOOK.soft }}>
            What you found
          </h3>
          <textarea
            key={item.id}
            defaultValue={item.notes ?? ""}
            onBlur={(e) => onNote(e.target.value)}
            placeholder="worked · didn't · only on the iPad · …"
            rows={3}
            className="w-full resize-y rounded-lg p-3 text-sm outline-none placeholder:opacity-60"
            style={{ background: LOOK.card, color: LOOK.ink, boxShadow: "0 1px 1px rgba(9,30,66,0.2)" }}
          />
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onMove}
            className="rounded px-3 py-2 text-sm font-medium"
            style={
              done
                ? { background: LOOK.card, color: LOOK.ink, boxShadow: "0 1px 1px rgba(9,30,66,0.2)" }
                : { background: LOOK.accent, color: "#fff" }
            }
          >
            {done ? "← Back to Built" : "✓ I watched this work"}
          </button>
          {/* **The third answer.** You looked and it was wrong — which is neither
              "checked" nor "not checked yet", and pretending it is one of those is
              how a thing gets tested twice or ticked off broken. The note above is
              the brief; this is the button that sends it back. */}
          {done ? null : (
            <button
              onClick={() => onSendTo(item.status === LOOK_AGAIN ? BUILT : LOOK_AGAIN)}
              className="rounded px-3 py-2 text-sm font-medium"
              style={
                item.status === LOOK_AGAIN
                  ? { background: LOOK.card, color: LOOK.ink, boxShadow: "0 1px 1px rgba(9,30,66,0.2)" }
                  : { background: LOOK.card, color: LOOK.danger, boxShadow: "0 1px 1px rgba(9,30,66,0.2)" }
              }
            >
              {item.status === LOOK_AGAIN ? "↩ Back to Built" : "✗ Look again"}
            </button>
          )}
          <span className="font-mono text-[11px] leading-tight" style={{ color: LOOK.soft }}>
            {item.verified_at ? (
              <>
                verified {stamp(item.verified_at)}
                <br />
              </>
            ) : null}
            added {stamp(item.created_at)}
            {item.shipped_at ? (
              <>
                <br />
                on device {stamp(item.shipped_at)}
                {item.shipped_build ? ` · ${item.shipped_build}` : ""}
              </>
            ) : null}
          </span>
          <button
            onClick={onDelete}
            className="ml-auto rounded px-3 py-2 text-sm hover:bg-black/5"
            style={{ color: LOOK.danger }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
