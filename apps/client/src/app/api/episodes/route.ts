import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getRequestUser } from "@/lib/server-auth";
import { parsePagination } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// GET /api/episodes?limit=30&offset=0&source=nts
export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getServiceClient();
  const { searchParams } = req.nextUrl;
  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parsePagination(searchParams, { defaultLimit: 30 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid pagination" }, { status: 400 });
  }
  const source = searchParams.get("source");

  const showSkipped = searchParams.get("show_skipped") === "true";

  let query = supabase
    .from("episodes")
    .select("*", { count: "exact" })
    .order("crawled_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (source) {
    query = query.eq("source", source);
  }

  if (!showSkipped) {
    query = query.or("skipped.is.null,skipped.eq.false");
  }

  const { data: episodes, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const episodeIds = (episodes || []).map((episode) => episode.id);
  const [statsResult, seedResult] = await Promise.all([
    supabase.rpc("episode_track_stats", { p_user_id: user.id }),
    episodeIds.length > 0
      ? supabase.from("episode_seeds")
          .select("episode_id,seed_id,seeds!inner(artist,title,user_id)")
          .in("episode_id", episodeIds)
          .eq("seeds.user_id", user.id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (statsResult.error || seedResult.error) {
    return NextResponse.json({ error: statsResult.error?.message || seedResult.error?.message }, { status: 500 });
  }
  const stats = statsResult.data;
  const statsMap = new Map(
    (stats || []).map((s: any) => [s.episode_id, s])
  );
  const seedsByEpisode = new Map<string, Array<{ id: string; artist: string; title: string }>>();
  for (const link of seedResult.data || []) {
    const nested = Array.isArray(link.seeds) ? link.seeds[0] : link.seeds;
    if (!nested) continue;
    const seeds = seedsByEpisode.get(link.episode_id) || [];
    seeds.push({ id: link.seed_id, artist: nested.artist, title: nested.title });
    seedsByEpisode.set(link.episode_id, seeds);
  }

  // Shape response
  const shaped = (episodes || []).map((ep: any) => ({
    id: ep.id,
    url: ep.url,
    title: ep.title,
    source: ep.source,
    aired_date: ep.aired_date,
    crawled_at: ep.crawled_at,
    skipped: ep.skipped || false,
    seeds: seedsByEpisode.get(ep.id) || [],
    track_stats: statsMap.get(ep.id) || { total: 0, pending: 0, approved: 0, rejected: 0 },
  }));

  return NextResponse.json({ episodes: shaped, total: count });
}
