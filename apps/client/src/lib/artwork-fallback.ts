"use client";

import { useEffect, useMemo, useState } from "react";

export function artworkCandidates(...urls: Array<string | null | undefined>): string[] {
  return Array.from(new Set(urls.filter((url): url is string => Boolean(url && url.trim()))));
}

/** Resolves CSS-background artwork through real image load events. */
export function useArtworkFallback(...urls: Array<string | null | undefined>): string | null {
  const candidates = useMemo(() => artworkCandidates(...urls), [urls.join("\u0000")]);
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let index = 0;
    setResolved(null);

    const tryNext = () => {
      if (cancelled || index >= candidates.length) {
        if (!cancelled) setResolved(null);
        return;
      }
      const candidate = candidates[index++];
      const image = new Image();
      image.onload = () => {
        if (!cancelled) setResolved(candidate);
      };
      image.onerror = tryNext;
      image.src = candidate;
    };

    tryNext();
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  return resolved;
}
