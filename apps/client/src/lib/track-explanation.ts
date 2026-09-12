export interface TrackExplanationInput {
  seriesExploration?: boolean | null;
  seedName?: string | null;
  tangentSeedName?: string | null;
  sonicSeedName?: string | null;
  matchType?: string | null;
  episodeLabel?: string | null;
  sourceName?: string | null;
  curatorName?: string | null;
  coOccurrence?: number | null;
  scoreComponents?: Record<string, number> | null;
}

export interface TrackExplanation {
  headline: string;
  evidence: string;
}

function strongestPositiveComponent(components: Record<string, number> | null | undefined): string | null {
  if (!components) return null;
  return Object.entries(components)
    .filter(([key, value]) => !key.startsWith("queue_") && key !== "penalty" && Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || null;
}

/** Build a listener-facing explanation. Raw scores remain a secondary diagnostic. */
export function explainTrackSelection(input: TrackExplanationInput): TrackExplanation {
  const seedName = input.tangentSeedName || input.seedName || null;
  const components = input.scoreComponents || {};
  const strongest = strongestPositiveComponent(components);

  if (input.tangentSeedName) {
    return {
      headline: `Added to your upcoming queue from a tangent off ${input.tangentSeedName}.`,
      evidence: "This was one of the bounded discoveries brought forward by that seed; the track you were already playing was left alone.",
    };
  }

  if (input.seriesExploration) {
    return {
      headline: input.episodeLabel
        ? `A fresh exploration pick from ${input.episodeLabel}.`
        : "A fresh pick from the exploration lane.",
      evidence: "This bounded slot samples a recent source directly; it is not presented as a prediction from your personal taste history.",
    };
  }

  if (input.matchType === "full" && seedName) {
    return {
      headline: `Found in a DJ set that also played ${seedName}.`,
      evidence: input.episodeLabel
        ? `The direct connection came through ${input.episodeLabel}.`
        : "The seed itself appeared in the same source set, which is stronger evidence than an artist-only match.",
    };
  }

  if (Number(components.sonic_similarity || 0) > 0 && input.sonicSeedName) {
    return {
      headline: `Its sound sits close to ${input.sonicSeedName} in your sonic map.`,
      evidence: "CLAP audio similarity contributed a bounded signal alongside your listening, source and curator history.",
    };
  }

  if (input.matchType === "artist" && seedName) {
    return {
      headline: `Discovered through an artist connection to ${seedName}.`,
      evidence: input.episodeLabel
        ? `That connection appeared in ${input.episodeLabel}; it is treated as weaker than the exact seed sharing a set.`
        : "This is an artist-level connection, so it receives less weight than a direct seed match.",
    };
  }

  if (strongest === "source_context" && input.episodeLabel) {
    return {
      headline: `Your history with ${input.episodeLabel} made this source promising.`,
      evidence: "Tracks from this show or source context have performed well in your previous decisions.",
    };
  }

  if (strongest === "curator" && input.curatorName) {
    return {
      headline: `You tend to keep tracks selected by ${input.curatorName}.`,
      evidence: input.episodeLabel
        ? `This track came through ${input.episodeLabel}.`
        : "That curator affinity is based on your own earlier decisions.",
    };
  }

  if (strongest === "episode_density" && input.episodeLabel) {
    return {
      headline: `Several tracks around ${input.episodeLabel} have matched your taste.`,
      evidence: "The episode signal is smoothed and only activates after enough of your own outcomes.",
    };
  }

  if ((strongest === "co_occurrence" || Number(input.coOccurrence || 0) > 1) && input.coOccurrence) {
    return {
      headline: `This connection appeared across ${input.coOccurrence} DJ sets linked to your seeds.`,
      evidence: "Repeated appearances help only when your outcomes give that pattern a positive direction.",
    };
  }

  if (strongest === "artist") {
    return {
      headline: "Your previous decisions suggest this artist is worth another listen.",
      evidence: "The artist signal is based only on your own approved, rejected and qualified listening history.",
    };
  }

  if (strongest === "genre") {
    return {
      headline: "It fits a sound you have responded well to before.",
      evidence: "Genre remains a weak supporting signal; it cannot create a recommendation by itself.",
    };
  }

  if (input.episodeLabel) {
    return {
      headline: `Discovered in ${input.episodeLabel}.`,
      evidence: `It was ranked against other unseen tracks using your personal listening and decision history${input.sourceName ? ` plus its ${input.sourceName} context` : ""}.`,
    };
  }

  return {
    headline: "Ranked above other unseen tracks using your personal taste history.",
    evidence: "The model combines only the evidence available for you; missing signals stay neutral rather than being invented.",
  };
}
