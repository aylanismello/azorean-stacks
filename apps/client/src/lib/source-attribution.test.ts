import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceAttribution, sourceLabel } from "./source-attribution";

const trackCard = readFileSync(
  new URL("../components/TrackCard.tsx", import.meta.url),
  "utf8",
);

describe("source attribution contract", () => {
  test("maps curated sources to clear display labels", () => {
    expect(sourceLabel("soulection")).toBe("Soulection");
    expect(sourceLabel("nts")).toBe("NTS");
    expect(sourceLabel("lotradio")).toBe("The Lot Radio");
  });

  test("preserves an explicit source episode title and canonical link", () => {
    expect(sourceAttribution({
      source: "soulection",
      sourceContext: "Soulection Radio Show #700",
      sourceUrl: "https://soulection.com/radio/show-700",
      episode: {
        title: "Fallback title",
        url: "https://example.com/fallback",
      },
    })).toEqual({
      label: "Soulection",
      context: "Soulection Radio Show #700",
      url: "https://soulection.com/radio/show-700",
    });
  });

  test("falls back to joined episode context without discarding it", () => {
    expect(sourceAttribution({
      source: "soulection",
      sourceContext: null,
      sourceUrl: null,
      episode: { title: "Soulection Radio Show #699", url: "https://soulection.com/radio/show-699" },
    })).toEqual({
      label: "Soulection",
      context: "Soulection Radio Show #699",
      url: "https://soulection.com/radio/show-699",
    });
  });

  test("TrackCard renders the source label before a separately linked episode context", () => {
    const attributionBlock = trackCard.slice(
      trackCard.indexOf("const sourceLabelBadge"),
      trackCard.indexOf("const externalLinks"),
    );

    expect(attributionBlock.indexOf("{attribution.label}")).toBeLessThan(
      attributionBlock.indexOf("{effectiveSourceContext}"),
    );
    expect(attributionBlock).toContain("aria-label={`Source: ${attribution.label}`}");
    expect(attributionBlock).toContain("aria-label={`Open ${attribution.label} episode: ${effectiveSourceContext}`}");
    expect(attributionBlock).toContain("href={effectiveSourceUrl}");
  });

  test("TrackCard suppresses duplicate context when it equals the source label", () => {
    expect(trackCard).toContain(
      "effectiveSourceContext.trim().toLocaleLowerCase()\n    !== attribution.label.trim().toLocaleLowerCase()",
    );
    expect(trackCard).toContain("{showAttributionContext && (");
  });
});
