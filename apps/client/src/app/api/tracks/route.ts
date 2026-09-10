import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";
import { getRequestUser } from "@/lib/server-auth";
import { parsePagination } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// Enrich tracks with episode_seeds match_type for discovery method differentiation
async function attachMatchTypes(tracks: any[]) {
  const episodeIds = Array.from(new Set(tracks.map((t: any) => t.episode_id).filter(Boolean)));
  if (episodeIds.length === 0) return;

  const { data: esLinks } = await getServiceClient()
    .from("episode_seeds")
    .select("episode_id, match_type")
    .in("episode_id", episodeIds);

  if (!esLinks?.length) return;

  // Per episode, prefer 'full' over 'artist' over 'unknown'
  const matchTypeMap = new Map<string, string>();
  for (const link of esLinks) {
    const existing = matchTypeMap.get(link.episode_id);
    if (!existing || link.match_type === "full") {
      matchTypeMap.set(link.episode_id, link.match_type || "unknown");
    }
  }

  for (const track of tracks) {
    if (track.episode_id && matchTypeMap.has(track.episode_id)) {
      track._match_type = matchTypeMap.get(track.episode_id);
    }
  }
}


// Normalize track joins and generate signed URLs
async function normalizeAndSign(tracks: any[]) {
  const signPromises: Promise<void>[] = [];
  for (const track of tracks) {
    if (Array.isArray(track.seed_track)) {
      track.seed_track = track.seed_track[0] || null;
    }
    if (track.seed_track && !track.seed_track.artist) {
      track.seed_track = null;
    }
    if (Array.isArray(track.episode)) {
      track.episode = track.episode[0] || null;
    }
    const seedArr = Array.isArray(track.seeds) ? track.seeds : [];
    track.seed_id = seedArr.length > 0 ? seedArr[0].id : null;
    delete track.seeds;
    const meta = (track.metadata || {}) as Record<string, unknown>;
    track._score_components = (meta._score_components as Record<string, number>) || {};
    track._ranked_score = track.taste_score ?? 0;
    if (track.storage_path) {
      signPromises.push(
        getServiceClient().storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) track.audio_url = signed.signedUrl;
          })
      );
    }
  }
  await Promise.all(signPromises);
}

// Paginated fetch of track_ids from user_tracks by status
async function getUserTrackIds(db: ReturnType<typeof getServiceClient>, userId: string, statuses: string[]): Promise<string[]> {
  const ids: string[] = [];
  let page = 0;
  while (true) {
    const { data: batch } = await db
      .from("user_tracks")
      .select("track_id")
      .eq("user_id", userId)
      .in("status", statuses)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    ids.push(...batch.map((r: any) => r.track_id));
    if (batch.length < 1000) break;
    page++;
  }
  return ids;
}

// GET /api/tracks?status=pending&limit=20
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "pending";
  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parsePagination(searchParams, { defaultLimit: 20 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid pagination" }, { status: 400 });
  }
  const search = searchParams.get("search");
  const source = searchParams.get("source");
  const episodeId = searchParams.get("episode_id");
  const orderBy = searchParams.get("order_by"); // "taste_score" or default
  const hideLow = searchParams.get("hide_low") === "true";
  const genre = searchParams.get("genre");
  const seedId = searchParams.get("seed_id");
  const seedArtist = searchParams.get("seed_artist");

  const isPending = status === "pending";

  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();

  // When episode_id is set, fetch ALL tracks in episode order (not filtered by status)
  if (episodeId) {
    const { data: etLinks } = await db
      .from("episode_tracks")
      .select("track_id, position")
      .eq("episode_id", episodeId)
      .order("position", { ascending: true, nullsFirst: false });

    const trackIdsForEpisode = (etLinks || []).map((r: any) => r.track_id);
    if (trackIdsForEpisode.length === 0) {
      return NextResponse.json({ tracks: [], total: 0 });
    }

    const orderMap = new Map(trackIdsForEpisode.map((id: string, i: number) => [id, i]));

    let query = db
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)", { count: "exact" })
      .in("id", trackIdsForEpisode);

    if (search) {
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    }
    if (source) {
      query = query.eq("source", source);
    }

    const { data, error, count } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const tracks = (data || []).sort((a: any, b: any) =>
      (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999)
    );

    await normalizeAndSign(tracks);
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total: count });
  }

  // Super-liked tab: resolve track IDs from user_tracks for current user
  if (status === "super_liked") {
    const utQuery = db
      .from("user_tracks")
      .select("track_id")
      .eq("super_liked", true)
      .eq("user_id", user.id);
    const { data: utRows, error: utError } = await utQuery
      .order("voted_at", { ascending: false });

    if (utError) return NextResponse.json({ error: utError.message }, { status: 500 });

    const superLikedIds = (utRows || []).map((r: any) => r.track_id);
    if (superLikedIds.length === 0) return NextResponse.json({ tracks: [], total: 0 });

    const paged = superLikedIds.slice(offset, offset + limit);
    const { data, error } = await db
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)")
      .in("id", paged);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const tracks = (data || []).sort((a: any, b: any) => superLikedIds.indexOf(a.id) - superLikedIds.indexOf(b.id));
    await normalizeAndSign(tracks);
    return NextResponse.json({ tracks, total: superLikedIds.length });
  }

  // ── User-isolated status views ──────────────────────────────────────────

  // User curation states always come from user_tracks, never shared tracks.status.
  if (["approved", "rejected", "skipped", "listened", "bad_source"].includes(status)) {
    const utIds = await getUserTrackIds(db, user.id, [status]);
    if (utIds.length === 0) return NextResponse.json({ tracks: [], total: 0 });

    const paged = utIds.slice(offset, offset + limit);
    let query = db
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)")
      .in("id", paged);

    if (search) {
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    }
    if (source) query = query.eq("source", source);
    if (genre) query = query.contains("metadata", { genres: [genre] });

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const tracks = data || [];
    // Overlay user status
    for (const t of tracks) {
      (t as any).status = status;
    }
    await normalizeAndSign(tracks);
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total: utIds.length });
  }

  // Pending is eligibility-scoped: a shared catalog row is not visible merely
  // because another user's discovery created it.
  if (isPending) {
    const pendingTrackIds = await getUserTrackIds(db, user.id, ["pending"]);
    if (pendingTrackIds.length === 0) {
      return NextResponse.json({ tracks: [], total: 0 });
    }

    const allPending: any[] = [];
    const scoreMap = new Map<string, { score: number; components: Record<string, number> }>();
    for (let start = 0; start < pendingTrackIds.length; start += 300) {
      const ids = pendingTrackIds.slice(start, start + 300);
      let pendingQuery = db
        .from("tracks")
        .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)")
        .in("id", ids)
        .eq("status", "pending")
        .or("storage_path.not.is.null,preview_url.not.is.null");
      if (search) {
        const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
        pendingQuery = pendingQuery.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
      }
      if (source) pendingQuery = pendingQuery.eq("source", source);
      if (genre) pendingQuery = pendingQuery.contains("metadata", { genres: [genre] });
      if (seedId) pendingQuery = pendingQuery.eq("seed_track_id", seedId);
      if (seedArtist) pendingQuery = pendingQuery.contains("metadata", { seed_artist: seedArtist });

      const [trackResult, scoreResult] = await Promise.all([
        pendingQuery,
        db.from("user_track_scores")
          .select("track_id, score, components")
          .eq("user_id", user.id)
          .in("track_id", ids),
      ]);
      if (trackResult.error) return NextResponse.json({ error: trackResult.error.message }, { status: 500 });
      if (scoreResult.error) return NextResponse.json({ error: scoreResult.error.message }, { status: 500 });
      allPending.push(...(trackResult.data || []));
      for (const score of scoreResult.data || []) {
        scoreMap.set(score.track_id, {
          score: Number(score.score || 0),
          components: (score.components || {}) as Record<string, number>,
        });
      }
    }

    let eligible = hideLow && orderBy === "taste_score"
      ? allPending.filter((track) => (scoreMap.get(track.id)?.score ?? 0) > -0.3)
      : allPending;
    eligible.sort((a, b) => orderBy === "taste_score"
      ? (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0)
      : String(a.created_at || "").localeCompare(String(b.created_at || "")));
    const total = eligible.length;
    if (orderBy === "taste_score") eligible = diversifyTracks(eligible);
    const tracks = eligible.slice(offset, offset + limit);
    await normalizeAndSign(tracks);
    for (const track of tracks) {
      const personalized = scoreMap.get(track.id);
      track.status = "pending";
      track._ranked_score = personalized?.score ?? 0;
      track._score_components = personalized?.components ?? {};
    }
    await attachMatchTypes(tracks);
    return NextResponse.json({ tracks, total });
  }

  const orderCol = orderBy === "taste_score" ? "taste_score" : "created_at";
  const ascending = orderBy !== "taste_score";
  const isTasteMode = orderBy === "taste_score";
  const targetCount = isTasteMode ? limit * 2 : limit;
  const batchSize = 40;
  const maxIterations = 5;

  let allTracks: any[] = [];
  let cursor = offset;
  let totalCount: number | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let query = db
      .from("tracks")
      .select("*, seed_track:tracks!seed_track_id(artist, title), episode:episodes!episode_id(id, title, source, aired_date, artwork_url, url), seeds!track_id(id)", { count: "exact" });

    query = query.eq("status", status);

    query = query.order(orderCol, { ascending, nullsFirst: false })
      .range(cursor, cursor + batchSize - 1);
    if (search) {
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (genre) {
      query = query.contains("metadata", { genres: [genre] });
    }
    if (seedId) {
      query = query.eq("seed_track_id", seedId);
    }
    if (seedArtist) {
      query = query.contains("metadata", { seed_artist: seedArtist });
    }
    if (hideLow && isTasteMode) {
      query = query.gt("taste_score", -0.3);
    }

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (totalCount === null) totalCount = count;

    allTracks.push(...(data || []));

    // Stop if we have enough or DB is exhausted
    if (allTracks.length >= targetCount) break;
    if (!data || data.length < batchSize) break;

    cursor += batchSize;
  }

  await normalizeAndSign(allTracks);

  // Apply diversification in taste mode then trim to requested limit
  const finalTracks = isTasteMode
    ? diversifyTracks(allTracks).slice(0, limit)
    : allTracks.slice(0, limit);

  await attachMatchTypes(finalTracks);

  return NextResponse.json({ tracks: finalTracks, total: totalCount });
}

// POST /api/tracks — agent pushes new discoveries (service role)
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Simple auth: require service role key as bearer token
  if (!serviceKey || !authHeader || authHeader !== `Bearer ${serviceKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const tracks: Array<{
    artist: string;
    title: string;
    source: string;
    source_url?: string;
    source_context?: string;
    seed_track_id?: string;
    preview_url?: string;
    cover_art_url?: string;
    metadata?: Record<string, unknown>;
  }> = Array.isArray(body) ? body : [body];

  const client = getServiceClient();
  const results = { added: 0, skipped: 0, errors: [] as string[] };

  for (const track of tracks) {
    if (!track.artist || !track.title || !track.source) {
      results.errors.push(`Missing required fields: ${JSON.stringify(track)}`);
      continue;
    }

    // Dedup check: artist + title (escape ilike pattern chars)
    const escArt = track.artist.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const escTtl = track.title.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const { data: existing } = await client
      .from("tracks")
      .select("id")
      .ilike("artist", escArt)
      .ilike("title", escTtl)
      .limit(1);

    if (existing && existing.length > 0) {
      results.skipped++;
      continue;
    }

    const { error } = await client.from("tracks").insert({
      artist: track.artist,
      title: track.title,
      source: track.source,
      source_url: track.source_url || null,
      source_context: track.source_context || null,
      seed_track_id: track.seed_track_id || null,
      preview_url: track.preview_url || null,
      cover_art_url: track.cover_art_url || null,
      metadata: track.metadata || {},
    });

    if (error) {
      results.errors.push(error.message);
    } else {
      results.added++;
    }
  }

  return NextResponse.json(results, { status: 201 });
}
