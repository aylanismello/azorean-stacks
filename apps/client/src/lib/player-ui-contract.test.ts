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
  test("uses explicit, unclipped 30-second seek labels", () => {
    expect(trackCard).toContain("−0:30");
    expect(trackCard).toContain("+0:30");
    expect(trackCard).not.toContain('fontSize="7"');
    expect(trackCard).toContain("min-w-16");
  });

  test("keeps the six vote actions evenly sized on mobile", () => {
    expect(trackCard).toContain('className="grid w-full grid-cols-6 items-center gap-2"');
    expect(trackCard).toContain("h-11 w-11 items-center justify-center justify-self-center");
  });

  test("shows connection quality only in phone player chrome", () => {
    const timeBlock = globalPlayer.slice(
      globalPlayer.indexOf("Time stays on larger screens"),
      globalPlayer.indexOf("Previous track"),
    );

    expect(timeBlock).toContain("sm:hidden");
    expect(timeBlock).toContain("<ConnectionIcon quality={connectionQuality} />");
    expect(timeBlock).toContain("md:flex");
    expect(timeBlock.indexOf("md:flex")).toBeLessThan(timeBlock.indexOf("sm:hidden"));
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
