import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";

export const dynamic = "force-dynamic";

const QUERY_PAGE_SIZE = 1000;
const MISSING_TABLE_RE = /could not find the table|does not exist|schema cache/i;

type Db = ReturnType<typeof getServiceClient>;

function getAuthClient(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
}

function joinedTrack(row: any) {
  return Array.isArray(row.track) ? row.track[0] : row.track;
}

async function getExcludedTrackIds(db: Db, userId: string) {
  const excluded = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await db.from("user_tracks")
      .select("track_id,status")
      .eq("user_id", userId)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    for (const opinion of data || []) {
      if (opinion.status !== "pending") excluded.add(opinion.track_id);
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }
  return excluded;
}

/**
 * Select the authenticated user's playable ranking before applying the API
 * offset. Ready queue entries are the tracks the warmer actually prepared;
 * scored playable tracks fill any gap without falling back to shared scores.
 */
async function getPersonalizedTracks(
  db: Db,
  userId: string,
  limit: number,
  offset: number,
  hideLow: boolean,
) {
  const target = offset + limit;
  if (target <= 0) return [];

  const excluded = await getExcludedTrackIds(db, userId);
  const ranked: any[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (let page = 0; ranked.length < target; page++) {
    let query = db.from("audio_preparation_queue")
      .select("track_id,rank,score,score_components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .eq("state", "ready")
      .gt("expires_at", now)
      .eq("track.status", "pending")
      .not("track.storage_path", "is", null)
      .order("rank", { ascending: true })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) {
      if (!MISSING_TABLE_RE.test(error.message)) throw error;
      break;
    }

    for (const queueRow of data || []) {
      const track = joinedTrack(queueRow);
      if (!track || excluded.has(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      ranked.push({
        ...track,
        taste_score: Number(queueRow.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: queueRow.score_components || {},
          _score_confidence: 0,
        },
      });
      if (ranked.length >= target) break;
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  for (let page = 0; ranked.length < target; page++) {
    let query = db.from("user_track_scores")
      .select("track_id,score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .eq("track.status", "pending")
      .not("track.storage_path", "is", null)
      .order("score", { ascending: false })
      .order("confidence", { ascending: false })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) {
      if (!MISSING_TABLE_RE.test(error.message)) throw error;
      break;
    }

    for (const scoreRow of data || []) {
      const track = joinedTrack(scoreRow);
      if (!track || excluded.has(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      ranked.push({
        ...track,
        taste_score: Number(scoreRow.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: scoreRow.components || {},
          _score_confidence: Number(scoreRow.confidence || 0),
        },
      });
      if (ranked.length >= target) break;
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  return ranked.slice(offset, target);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = parseInt(searchParams.get("limit") || "20", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const seedId = searchParams.get("seed_id") || null;
  const genre = searchParams.get("genre") || null;
  const seedArtist = searchParams.get("seed_artist") || null;
  const hideLow = searchParams.get("hide_low") === "true";

  const auth = getAuthClient(req);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getServiceClient();
  const isFiltered = Boolean(seedId || genre || seedArtist);
  let rows: any[];

  if (isFiltered) {
    // Preserve the established RPC semantics for seed/genre views.
    const { data: tracks, error } = await db.rpc("get_fyp_tracks", {
      p_user_id: user.id,
      p_limit: limit,
      p_offset: offset,
      p_seed_id: seedId,
      p_genre: genre,
      p_seed_artist: seedArtist,
      p_hide_low: hideLow,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    rows = tracks || [];

    // Filtered RPC rows retain their existing behavior, including personalized
    // score display when a snapshot exists for the returned candidates.
    if (rows.length > 0) {
      const personalized = await db.from("user_track_scores")
        .select("track_id,score,confidence,components")
        .eq("user_id", user.id)
        .in("track_id", rows.map((track: any) => track.id));
      if (!personalized.error) {
        const scoreMap = new Map((personalized.data || []).map((score: any) => [score.track_id, score]));
        for (const track of rows) {
          const score: any = scoreMap.get(track.id);
          if (!score) continue;
          track.taste_score = Number(score.score || 0);
          track.metadata = {
            ...(track.metadata || {}),
            _score_components: score.components || {},
            _score_confidence: Number(score.confidence || 0),
          };
        }
        rows.sort((a: any, b: any) => Number(b.taste_score || 0) - Number(a.taste_score || 0));
      } else if (!MISSING_TABLE_RE.test(personalized.error.message)) {
        return NextResponse.json({ error: personalized.error.message }, { status: 500 });
      }
    }
  } else {
    try {
      rows = await getPersonalizedTracks(db, user.id, limit, offset, hideLow);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load personalized FYP";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const seedTrackIds = Array.from(new Set(rows.map((t: any) => t.seed_track_id).filter(Boolean)));
  const episodeIds = Array.from(new Set(rows.map((t: any) => t.episode_id).filter(Boolean)));

  // Resolve episode lineage only through this user's canonical seeds. The
  // service client bypasses RLS, so both seed ownership and link IDs are
  // constrained explicitly.
  const userSeedsRes = episodeIds.length > 0
    ? await db.from("seeds").select("id,artist,title").eq("user_id", user.id)
    : { data: [], error: null };
  if (userSeedsRes.error) {
    return NextResponse.json({ error: userSeedsRes.error.message }, { status: 500 });
  }
  const userSeeds = userSeedsRes.data || [];
  const userSeedIds = userSeeds.map((seed: any) => seed.id);

  const [seedTrackRes, episodeRes, esRes] = await Promise.all([
    seedTrackIds.length > 0
      ? db.from("tracks").select("id, artist, title").in("id", seedTrackIds)
      : { data: [], error: null },
    episodeIds.length > 0
      ? db.from("episodes").select("id, title, source, aired_date, artwork_url, url").in("id", episodeIds)
      : { data: [], error: null },
    episodeIds.length > 0 && userSeedIds.length > 0
      ? db.from("episode_seeds")
          .select("episode_id, seed_id, match_type")
          .in("episode_id", episodeIds)
          .in("seed_id", userSeedIds)
      : { data: [], error: null },
  ]);

  for (const result of [seedTrackRes, episodeRes, esRes]) {
    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }
  }

  const seedTrackMap = new Map((seedTrackRes.data || []).map((seed: any) => [seed.id, seed]));
  const episodeMap = new Map((episodeRes.data || []).map((episode: any) => [episode.id, episode]));
  const userSeedMap = new Map(userSeeds.map((seed: any) => [seed.id, seed]));

  // Prefer the requested seed in a seed-filtered view, otherwise the strongest
  // canonical match when an episode has multiple links for this user.
  const lineageMap = new Map<string, { matchType: string; seed: any; requested: boolean }>();
  for (const link of esRes.data || []) {
    const seed = userSeedMap.get(link.seed_id);
    if (!seed) continue;
    const existing = lineageMap.get(link.episode_id);
    const requested = link.seed_id === seedId;
    const shouldReplace = !existing
      || (requested && !existing.requested)
      || (requested === existing.requested && existing.matchType !== "full" && link.match_type === "full");
    if (shouldReplace) {
      lineageMap.set(link.episode_id, {
        matchType: link.match_type || "unknown",
        seed,
        requested,
      });
    }
  }

  const signPromises: Promise<void>[] = [];
  for (const track of rows) {
    const lineage = lineageMap.get(track.episode_id);
    track.seed_track = seedTrackMap.get(track.seed_track_id) || null;
    track.episode = episodeMap.get(track.episode_id) || null;
    track._match_type = lineage?.matchType || null;
    track._seed_name = lineage ? `${lineage.seed.artist} — ${lineage.seed.title}` : undefined;
    track._seed_artist = lineage?.seed.artist;
    track._seed_title = lineage?.seed.title;
    track.is_seed = track.is_seed ?? false;
    track.is_re_seed = track.is_re_seed ?? false;
    track.is_artist_seed = track.is_artist_seed ?? false;
    const meta = (track.metadata || {}) as Record<string, unknown>;
    track._score_components = (meta._score_components as Record<string, number>) || {};
    track._ranked_score = track.taste_score ?? 0;

    if (track.storage_path) {
      signPromises.push(
        db.storage
          .from("tracks")
          .createSignedUrl(track.storage_path, 3600)
          .then(({ data: signed }) => {
            if (signed) track.audio_url = signed.signedUrl;
          })
      );
    }
  }
  await Promise.all(signPromises);

  const diversified = diversifyTracks(rows);

  // Retain the response contract used by the existing FYP consumers.
  const { count } = await db
    .from("tracks")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .not("storage_path", "is", null);

  return NextResponse.json({ tracks: diversified, total: count ?? rows.length });
}
