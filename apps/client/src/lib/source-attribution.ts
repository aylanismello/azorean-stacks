const SOURCE_LABELS: Record<string, string> = {
  nts: "NTS",
  lotradio: "The Lot Radio",
  "1001tracklists": "1001TL",
  soulection: "Soulection",
  spotify: "Spotify",
  bandcamp: "Bandcamp",
  manual: "Manual",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source.toLowerCase()] || source;
}

interface SourceEpisode {
  title?: string | null;
  url?: string | null;
}

interface SourceAttributionInput {
  source: string;
  sourceContext?: string | null;
  sourceUrl?: string | null;
  episode?: SourceEpisode | null;
}

/** Keep explicit FYP attribution intact, then fall back to the episode join. */
export function sourceAttribution(input: SourceAttributionInput): {
  label: string;
  context: string;
  url: string | null;
} {
  const label = sourceLabel(input.source);
  return {
    label,
    context: input.sourceContext || input.episode?.title || label,
    url: input.sourceUrl || input.episode?.url || null,
  };
}
