"use client";

import { VERIFIED, deviceLabel, isTestable, type Item } from "./types";
import { LOOK, labelFor, stamp } from "./look";

/**
 * One card. A colour for its area, a title, and the small facts underneath —
 * whether it carries steps to check, whether you have left a note, and when.
 *
 * The tick box is not decoration. On a phone there is no drag at all, so that
 * box *is* how a card moves, which is why it gets a hit area bigger than itself.
 */
export function Card({
  item,
  dragging,
  showGapAbove,
  onOpen,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onDropOnCard,
}: {
  item: Item;
  dragging: boolean;
  showGapAbove: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
  onDropOnCard: () => void;
}) {
  const done = item.status === VERIFIED;
  // a card whose build is not on its devices yet cannot be checked — said plainly
  // rather than left to be discovered by going and looking
  const waiting = !isTestable(item);

  return (
    <div>
      {showGapAbove ? (
        <div
          className="mb-2 h-9 rounded-lg border-2 border-dashed"
          style={{ borderColor: LOOK.accent, background: "rgba(12,102,228,0.06)" }}
        />
      ) : null}

      <div
        draggable
        onDragStart={(e) => {
          onDragStart();
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          if (dragging) return;
          e.preventDefault();
          e.stopPropagation();
          onDragOverCard();
        }}
        onDrop={(e) => {
          if (dragging) return;
          e.preventDefault();
          e.stopPropagation();
          onDropOnCard();
        }}
        className={`cursor-grab rounded-lg p-2 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing ${
          dragging ? "rotate-2 opacity-40" : ""
        }`}
        style={{ background: LOOK.card, boxShadow: "0 1px 1px rgba(9,30,66,0.25)", opacity: waiting ? 0.62 : 1 }}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="h-2 w-10 rounded" style={{ background: labelFor(item.area) }} />
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: LOOK.soft }}>
            {item.area}
          </span>
          {/* where to look. Solid once the build is on them; outlined while it is not. */}
          {item.devices.map((d) => (
            <span
              key={d}
              className="rounded px-1.5 py-px font-mono text-[9px] uppercase tracking-wide"
              style={
                waiting
                  ? { color: LOOK.soft, border: `1px dashed ${LOOK.line}` }
                  : { color: "#fff", background: LOOK.listInk }
              }
            >
              {deviceLabel(d)}
            </span>
          ))}
        </div>

        <div className="flex items-start gap-2">
          <button
            onClick={onToggle}
            aria-label={done ? "Send back to built" : "Mark verified"}
            className="-m-1.5 mt-0 box-content shrink-0 rounded border p-1.5 transition-colors md:-m-1 md:p-1"
            style={{
              borderColor: done ? LOOK.accent : LOOK.line,
              background: done ? LOOK.accent : "transparent",
              color: "#fff",
            }}
          >
            <span className="block h-4 w-4 text-center text-[11px] leading-4 md:h-3.5 md:w-3.5 md:leading-[0.875rem]">
              {done ? "✓" : ""}
            </span>
          </button>

          <button onClick={onOpen} className="min-w-0 flex-1 text-left">
            <p
              className="text-sm leading-snug"
              style={{ color: LOOK.ink, textDecoration: done ? "line-through" : undefined, opacity: done ? 0.6 : 1 }}
            >
              {item.title}
            </p>
            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]"
              style={{ color: LOOK.soft }}
            >
              {item.detail ? <span title="has steps to check">☰</span> : null}
              {item.notes?.trim() ? <span title="you left a note">✎</span> : null}
              {/* the moment that matters: when you signed it off, or failing
                  that when it landed on the board waiting for you */}
              {item.verified_at ? (
                <span title="when you verified it" style={{ color: LOOK.accent }}>
                  ✓ {stamp(item.verified_at)}
                </span>
              ) : (
                <span title="when it landed on the board">{stamp(item.created_at)}</span>
              )}
              {waiting ? (
                <span style={{ color: LOOK.danger }}>not on your {item.devices.map(deviceLabel).join(" / ")} yet</span>
              ) : null}
              {item.source ? <span className="truncate">{item.source}</span> : null}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
