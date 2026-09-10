import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getServiceClient();
  const { data: series, error } = await db.from("mix_series")
    .select("id,slug,title,description,source,source_url,artwork_url,featured,metadata")
    .order("featured", { ascending: false }).order("title");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ids = (series || []).map((item) => item.id);
  if (!ids.length) return NextResponse.json({ series: [] });
  const [{ data: seeds, error: seedError }, { data: episodes, error: episodeError }] = await Promise.all([
    db.from("user_series_seeds").select("series_id").eq("user_id", user.id).in("series_id", ids),
    db.from("episodes").select("id,series_id,title,release_date,aired_date,artwork_url,dj_name")
      .in("series_id", ids).order("release_date", { ascending: false, nullsFirst: false }).limit(100),
  ]);
  if (seedError || episodeError) return NextResponse.json({ error: seedError?.message || episodeError?.message }, { status: 500 });
  const episodeIds = (episodes || []).map((episode) => episode.id);
  const { data: entries, error: entryError } = episodeIds.length
    ? await db.from("episode_track_entries").select("episode_id").in("episode_id", episodeIds)
    : { data: [], error: null };
  if (entryError) return NextResponse.json({ error: entryError.message }, { status: 500 });
  const counts = new Map<string, number>();
  for (const entry of entries || []) counts.set(entry.episode_id, (counts.get(entry.episode_id) || 0) + 1);
  const seeded = new Set((seeds || []).map((seed) => seed.series_id));
  return NextResponse.json({
    series: (series || []).map((item) => {
      const qualified = (episodes || []).filter((episode) => episode.series_id === item.id && (counts.get(episode.id) || 0) > 0);
      return { ...item, seeded: seeded.has(item.id), episode_count: qualified.length, latest_episode: qualified[0] || null };
    }),
  });
}
