import { describe, expect, test } from "bun:test";
import { episodeRow, extractEpisodesAction, extractInitialPage, parseRscPage } from "./crawl-lotradio";

describe("Lot Radio index parsing", () => {
  test("extracts initial cursor data from a flight script", () => {
    const flight = 'x:{"initialData":{"items":[{"sys":{"id":"episode-1"},"slug":"2026-09-09-1800"}],"total":3492,"pages":{"next":"cursor-2","prev":null}}}';
    const html = `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
    const page = extractInitialPage(html);
    expect(page.total).toBe(3492);
    expect(page.items[0].slug).toBe("2026-09-09-1800");
    expect(page.pages.next).toBe("cursor-2");
  });

  test("discovers only the getEpisodes server reference", () => {
    const bundle = '(0,x.createServerReference)("404392795f6b4c9e7fbaa47e53b1cf07b54ce2bfc5",x.callServer,void 0,x.findSourceMapURL,"getEpisodeFacetValues");(0,x.createServerReference)("404c777e51da10a130ababf450109e62056d9dae07",x.callServer,void 0,x.findSourceMapURL,"getEpisodes")';
    expect(extractEpisodesAction(bundle)).toBe("404c777e51da10a130ababf450109e62056d9dae07");
  });

  test("skips the server action envelope before the episode page", () => {
    const response = [
      '0:{"a":"$@1","f":"","q":"","i":false}',
      '1:{"items":[{"sys":{"id":"episode-2"},"slug":"2026-09-06-1500"}],"total":3492,"pages":{"next":"cursor-3","prev":"cursor-1"}}',
      "",
    ].join("\n");
    const page = parseRscPage(response);
    expect(page.items[0].sys.id).toBe("episode-2");
    expect(page.pages.next).toBe("cursor-3");
  });

  test("does not turn missing tracklist data into a confirmed empty tracklist", () => {
    const missing = episodeRow({ sys: { id: "missing" }, slug: "2026-09-10-1200", tracklist: null });
    expect(missing.hasTracklistData).toBe(false);
    expect("metadata" in missing).toBe(false);
    expect("skipped" in missing).toBe(false);

    const empty = episodeRow({ sys: { id: "empty" }, slug: "2026-09-10-1300", tracklist: [] });
    expect(empty.hasTracklistData).toBe(true);
    if (!empty.hasTracklistData) throw new Error("Expected confirmed tracklist data");
    expect(empty.skipped).toBe(true);
    expect(empty.metadata.tracklist).toEqual([]);
  });
});
