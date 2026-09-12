import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const trackCard = readFileSync(
  new URL("../components/TrackCard.tsx", import.meta.url),
  "utf8",
);
const globalPlayer = readFileSync(
  new URL("../components/GlobalPlayer.tsx", import.meta.url),
  "utf8",
);
const seekStepButton = readFileSync(
  new URL("../components/SeekStepButton.tsx", import.meta.url),
  "utf8",
);
const navigation = readFileSync(
  new URL("../components/Navigation.tsx", import.meta.url),
  "utf8",
);
const fypPage = readFileSync(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const tracklist = readFileSync(
  new URL("../components/EpisodeTracklist.tsx", import.meta.url),
  "utf8",
);

describe("player control layout contract", () => {
  test("uses animated circular 30-second SVG controls instead of text pills", () => {
    expect(trackCard).not.toContain("−0:30");
    expect(trackCard).not.toContain("+0:30");
    expect(trackCard).toContain('<SeekStepButton');
    expect(seekStepButton).toContain('viewBox="0 0 34 34"');
    expect(seekStepButton).toContain('fontSize="9.5"');
    expect(seekStepButton).toContain("h-11 w-11");
    expect(seekStepButton).toContain("Rewind 30 seconds");
    expect(seekStepButton).toContain("Skip ahead 30 seconds");
  });

  test("keeps the six vote actions evenly sized on mobile", () => {
    expect(trackCard).toContain('className="grid w-full grid-cols-6 items-center gap-2"');
    expect(trackCard).toContain("h-11 w-11 items-center justify-center justify-self-center");
  });

  test("hides healthy connectivity and shows actionable problems at every width", () => {
    const timeBlock = globalPlayer.slice(
      globalPlayer.indexOf("Time stays on larger screens"),
      globalPlayer.indexOf("Previous track"),
    );

    expect(timeBlock).not.toContain("sm:hidden");
    expect(timeBlock).toContain('connectionQuality !== "good"');
    expect(timeBlock).toContain("<ConnectionIcon quality={connectionQuality} />");
    expect(timeBlock).toContain("md:flex");
  });

  test("keeps tablet widths on the unclipped compact layout", () => {
    expect(trackCard).toContain("xl:hidden");
    expect(trackCard).toContain("xl:flex");
    expect(navigation).toContain("lg:hidden");
    expect(navigation).toContain("hidden lg:flex");
    expect(fypPage).toContain("xl:flex-row");
    expect(tracklist).toContain("sheet-enter xl:hidden");
    expect(globalPlayer).toContain("lg:bottom-0");
  });
});
