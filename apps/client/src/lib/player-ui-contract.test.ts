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
const globalPlayerProvider = readFileSync(
  new URL("../components/GlobalPlayerProvider.tsx", import.meta.url),
  "utf8",
);
const seedToggleRoute = readFileSync(
  new URL("../app/api/seeds/toggle/route.ts", import.meta.url),
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
const globals = readFileSync(
  new URL("../app/globals.css", import.meta.url),
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

  test("keeps the re-seed sprout clickable as an accessible add/remove toggle", () => {
    expect(trackCard).toContain('action: "toggle"');
    expect(trackCard).toContain("onClick={handleToggleSeed}");
    expect(trackCard).toContain("aria-pressed={seeded}");
    expect(trackCard).toContain('seeded ? "Remove re-seed" : "Plant as re-seed"');
    expect(trackCard).not.toContain("disabled={seeding || seeded}");
    expect(trackCard).toContain("onSeedChange?.(nextSeeded)");
    expect(fypPage).toContain('onSeedChange={(seeded) => beginActionMutation(seeded ? "seed" : "unseed"');
    expect(globalPlayerProvider).toContain("setTrackSeeded: (trackId: string, seeded: boolean");
    expect(seedToggleRoute).toContain('action !== "ensure" && action !== "toggle"');
  });

  test("keeps recently passed tracks in a replayable browser-tab history", () => {
    expect(globalPlayerProvider).toContain('sessionStorage.getItem("stacks-playback-history-v1")');
    expect(globalPlayerProvider).toContain("rememberCurrentTrack(track.id)");
    expect(globalPlayerProvider).toContain("history,");
    expect(tracklist).toContain('showHistory ? "Queue"');
    expect(tracklist).toContain("See recently passed tracks");
    expect(tracklist).toContain("globalPlayer.history.find");
    expect(tracklist).toContain("globalPlayer.clearHistory");
  });

  test("uses the tangent tree button as an accessible open/close toggle", () => {
    expect(fypPage).toContain("const nextOpen = !tangentPanelOpen");
    expect(fypPage).toContain("setTangentPanelOpen(nextOpen)");
    expect(fypPage).toContain("aria-pressed={tangentPanelOpen}");
    expect(fypPage).toContain('tangentPanelOpen ? "Close tangent feed" : "Open tangent feed"');
  });

  test("exposes a side tangent feed with an explicit branch action and growing tree", () => {
    expect(fypPage).toContain('aria-label="Tangent feed"');
    expect(fypPage).toContain("Grow a tangent from this track");
    expect(fypPage).toContain("New branches will land in your upcoming feed");
    expect(fypPage).toContain("handleTangentReplay(track)");
    expect(fypPage).toContain("It does not replace the active 4U queue");
    expect(fypPage).toContain("tangent-tree-trunk");
    expect(fypPage).toContain("tangent-tree-branch");
    expect(globals).toContain("@keyframes tangent-feed-panel-in");
    expect(globals).toContain("@keyframes tangent-tree-draw");
    expect(globals).toContain("@keyframes tangent-trunk-grow");
    expect(globals).toContain("@keyframes tangent-leaf-pop");
  });

  test("shows restrained living-tree feedback and exact queue swaps for discovery actions", () => {
    expect(fypPage).toContain("beginActionMutation(\"super_like\"");
    expect(fypPage).toContain("completeDiscoveryMutation(");
    expect(fypPage).toContain("discovery-mutation-chip");
    expect(tracklist).toContain("discovery-queue-swap");
    expect(tracklist).toContain("mutation.outgoing.artist");
    expect(tracklist).toContain("mutation.incoming.artist");
    expect(globals).toContain("@keyframes discovery-chip-in");
    expect(globals).toContain("@keyframes discovery-swap-out");
    expect(globals).toContain("@keyframes discovery-swap-in");
    expect(globals).toContain("prefers-reduced-motion: reduce");
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
