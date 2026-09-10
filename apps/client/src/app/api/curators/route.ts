import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getRequestUser } from "@/lib/server-auth";
import { parsePagination } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// GET /api/curators — list curators sorted by seed relevance
export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { searchParams } = req.nextUrl;
  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parsePagination(searchParams, { defaultLimit: 50 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid pagination" }, { status: 400 });
  }

  // Fetch curators
  const { data: curators, error } = await db
    .from("curators")
    .select("*");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Episode counts per curator
  const { data: epRows } = await db
    .from("episodes")
    .select("curator_id")
    .not("curator_id", "is", null);

  const epCountMap: Record<string, number> = {};
  for (const r of epRows || []) {
    if (r.curator_id) epCountMap[r.curator_id] = (epCountMap[r.curator_id] || 0) + 1;
  }

  // Seed relevance is user-owned. Do not expose another user's discovery
  // lineage through a service-role aggregate.
  const { data: matchRows, error: matchError } = await db
    .from("episode_seeds")
    .select("episode_id,seeds!inner(user_id),episodes!inner(curator_id)")
    .eq("seeds.user_id", user.id);
  if (matchError) return NextResponse.json({ error: matchError.message }, { status: 500 });
  const matchMap: Record<string, number> = {};
  const matchedEpisodes = new Set<string>();
  for (const row of (matchRows || []) as any[]) {
    const episode = Array.isArray(row.episodes) ? row.episodes[0] : row.episodes;
    if (!episode?.curator_id) continue;
    const identity = `${episode.curator_id}:${row.episode_id}`;
    if (matchedEpisodes.has(identity)) continue;
    matchedEpisodes.add(identity);
    matchMap[episode.curator_id] = (matchMap[episode.curator_id] || 0) + 1;
  }

  // Shape and sort
  const shaped = (curators || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    source: c.source,
    source_url: c.source_url,
    avatar_url: c.avatar_url,
    description: c.description,
    location: c.location,
    genres: c.genres || [],
    external_links: c.external_links || [],
    enriched_at: c.enriched_at,
    created_at: c.created_at,
    episode_count: epCountMap[c.id] || 0,
    matched_episodes: matchMap[c.id] || 0,
  }));

  // Sort: seed matches desc, then episode count desc
  shaped.sort((a: any, b: any) => {
    if (b.matched_episodes !== a.matched_episodes) return b.matched_episodes - a.matched_episodes;
    return b.episode_count - a.episode_count;
  });

  const paginated = shaped.slice(offset, offset + limit);

  return NextResponse.json({
    curators: paginated,
    total: shaped.length,
  });
}
