"use client";

import { useState } from "react";

interface SeekStepButtonProps {
  direction: "back" | "forward";
  onSeek: () => void;
  className?: string;
}

/** Directional 30-second transport control with a replay-style motion cue. */
export function SeekStepButton({ direction, onSeek, className = "" }: SeekStepButtonProps) {
  const [motionKey, setMotionKey] = useState(0);
  const backward = direction === "back";
  const label = backward ? "Rewind 30 seconds" : "Skip ahead 30 seconds";

  return (
    <button
      type="button"
      onClick={() => {
        setMotionKey((value) => value + 1);
        onSeek();
      }}
      className={`seek-step-button flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 active:bg-white/15 ${className}`}
      title={label}
      aria-label={label}
    >
      <svg
        key={motionKey}
        aria-hidden="true"
        className={`seek-step-glyph ${backward ? "seek-step-glyph-back" : "seek-step-glyph-forward"}`}
        width="34"
        height="34"
        viewBox="0 0 34 34"
        fill="none"
      >
        <g transform={backward ? "translate(34 0) scale(-1 1)" : undefined}>
          <path
            d="M9.2 10.2A10.5 10.5 0 1 1 7 22.6"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path
            d="M9.4 5.8 9 10.5l4.7-.1"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <text
          x="17"
          y="20.2"
          textAnchor="middle"
          fill="currentColor"
          fontSize="9.5"
          fontWeight="800"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          30
        </text>
      </svg>
    </button>
  );
}
