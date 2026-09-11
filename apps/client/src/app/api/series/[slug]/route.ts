import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";
import { canonicalEntryAvailability, episodeFishingPotential } from "@/lib/episode-fishing";
import { recentFirst } from "@/lib/mix-series";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };
const EPISODE_CANDIDATE_WINDOW = 22;

export async function GET(req: NextRequest, props: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await props.params;
  const db = getServiceClient();
  const { data: series, error } = await db.from("mix_series").select("*").eq("slug", slug).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!series) return NextResponse.json({ error: "Series not found" }, { status: 404 });
  const episodeSelect = "id,title,description,url,release_date,aired_date,artwork_url,dj_name,soundcloud_url,apple_music_url";
  const [{ data: seed }, releasedEpisodes, airedOnlyEpisodes] = await Promise.all([
    db.from("user_series_seeds").select("id").eq("user_id", user.id).eq("series_id", series.id).maybeSingle(),
    db.from("episodes").select(episodeSelect)
      .eq("series_id", series.id)
      .order("release_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(EPISODE_CANDIDATE_WINDOW),
    db.from("episodes").select(episodeSelect)
      .eq("series_id", series.id)
      .is("release_date", null)
      .order("aired_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(EPISODE_CANDIDATE_WINDOW),
  ]);
  const episodeError = releasedEpisodes.error || airedOnlyEpisodes.error;
  if (episodeError) return NextResponse.json({ error: episodeError.message }, { status: 500 });
  const episodes = recentFirst([
    ...new Map(
      [...(releasedEpisodes.data || []), ...(airedOnlyEpisodes.data || [])]
        .map((episode) => [episode.id, episode]),
    ).values(),
  ]).slice(0, 12);
  const episodeIds = (episodes || []).map((episode) => episode.id);
  const { data: entries, error: entryError } = episodeIds.length
    ? await db.from("episode_track_entries")
      .select("episode_id,track_id,resolution_state,tracks(youtube_url,storage_path,preview_url,spotify_url)")
      .in("episode_id", episodeIds)
    : { data: [], error: null };
  if (entryError) return NextResponse.json({ error: entryError.message }, { status: 500 });
  const stats = new Map<string, { rows: number; resolved: number; fishable: number }>();
  for (const entry of entries || []) {
    const value = stats.get(entry.episode_id) || { rows: 0, resolved: 0, fishable: 0 };
    value.rows++;
    const availability = canonicalEntryAvailability(entry);
    if (availability.resolved) value.resolved++;
    if (availability.fishable) value.fishable++;
    stats.set(entry.episode_id, value);
  }
  const recent = (episodes || []).filter((episode) => (stats.get(episode.id)?.rows || 0) > 0)
    .map((episode) => {
      const episodeStats = stats.get(episode.id)!;
      const fishing = episodeFishingPotential({
        trackCount: episodeStats.rows,
        resolvedCount: episodeStats.resolved,
        fishableCount: episodeStats.fishable,
        releaseDate: episode.release_date || episode.aired_date,
      });
      return {
        ...episode,
        track_count: episodeStats.rows,
        resolved_count: episodeStats.resolved,
        acquisition_ready_count: episodeStats.fishable,
        fishing_label: fishing.label,
        fishing_score: fishing.score,
        fishing_reason: fishing.reason,
      };
    });
  return NextResponse.json({ series: { ...series, seeded: !!seed, episodes: recent, latest_episode: recent[0] || null } });
}
