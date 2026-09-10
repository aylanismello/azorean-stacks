import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, props: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await props.params;
  const db = getServiceClient();
  const { data: series, error } = await db.from("mix_series").select("*").eq("slug", slug).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!series) return NextResponse.json({ error: "Series not found" }, { status: 404 });
  const [{ data: seed }, { data: episodes, error: episodeError }] = await Promise.all([
    db.from("user_series_seeds").select("id").eq("user_id", user.id).eq("series_id", series.id).maybeSingle(),
    db.from("episodes").select("id,title,description,url,release_date,aired_date,artwork_url,dj_name,soundcloud_url,apple_music_url,featured")
      .eq("series_id", series.id).order("release_date", { ascending: false, nullsFirst: false }).limit(12),
  ]);
  if (episodeError) return NextResponse.json({ error: episodeError.message }, { status: 500 });
  const episodeIds = (episodes || []).map((episode) => episode.id);
  const { data: entries, error: entryError } = episodeIds.length
    ? await db.from("episode_track_entries").select("episode_id,track_id").in("episode_id", episodeIds)
    : { data: [], error: null };
  if (entryError) return NextResponse.json({ error: entryError.message }, { status: 500 });
  const stats = new Map<string, { rows: number; resolved: number }>();
  for (const entry of entries || []) {
    const value = stats.get(entry.episode_id) || { rows: 0, resolved: 0 };
    value.rows++;
    if (entry.track_id) value.resolved++;
    stats.set(entry.episode_id, value);
  }
  const recent = (episodes || []).filter((episode) => (stats.get(episode.id)?.rows || 0) > 0)
    .map((episode) => ({ ...episode, track_count: stats.get(episode.id)!.rows, resolved_count: stats.get(episode.id)!.resolved }));
  return NextResponse.json({ series: { ...series, seeded: !!seed, episodes: recent, latest_episode: recent[0] || null } });
}
