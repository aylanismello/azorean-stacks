import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks, paceTracks } from "@/lib/diversify";
import { loadPersonalizedFyp } from "@/lib/fyp-personalization";
import {
  loadFypWithOptionalExploration,
  signOptionalExplorationAudio,
} from "@/lib/fyp-with-optional-exploration";
import { parsePagination } from "@/lib/pagination";
import { buildRankingExposureRows } from "@/lib/ranking-exposure";
import { injectSeriesExploration, loadSeriesExploration } from "@/lib/series-exploration";

export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parsePagination(searchParams, { defaultLimit: 20 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid pagination" }, { status: 400 });
  }
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
  let shouldExplore = false;
  if (offset === 0 && !seedId && !genre && !seedArtist) {
    shouldExplore = true;
  }
  let rows: any[];
  let seriesExploration: any[];
  try {
    ({ rows, seriesExploration } = await loadFypWithOptionalExploration({
      loadPersonalized: () => loadPersonalizedFyp(db, user.id, {
        limit, offset, hideLow, seedId, genre, seedArtist,
      }),
      loadExploration: (ordinaryRows) => loadSeriesExploration(
        db,
        user.id,
        new Set(ordinaryRows.map((track: any) => track.id)),
      ),
      shouldExplore,
    }));
  } catch (error) {
    const status = error instanceof Error && "status" in error && error.status === 404 ? 404 : 500;
    const message = error instanceof Error ? error.message : "Failed to load personalized FYP";
    return NextResponse.json({ error: message }, { status });
  }

  const seedTrackIds = Array.from(new Set(rows.map((t: any) => t.seed_track_id).filter(Boolean)));
  const rowTrackIds = rows.map((track: any) => track.id);
  const appearanceResult = rowTrackIds.length
    ? await db.from("episode_tracks").select("track_id,episode_id,position").in("track_id", rowTrackIds)
    : { data: [], error: null };
  if (appearanceResult.error) {
    return NextResponse.json({ error: appearanceResult.error.message }, { status: 500 });
  }
  const appearanceEpisodeIds = (appearanceResult.data || []).map((row: any) => row.episode_id).filter(Boolean);
  const episodeIds = Array.from(new Set([
    ...rows.map((track: any) => track.episode_id).filter(Boolean),
    ...appearanceEpisodeIds,
  ]));

  // Resolve episode lineage only through this user's canonical seeds. The
  // service client bypasses RLS, so both seed ownership and link IDs are
  // constrained explicitly.
  const userSeedsRes = await db.from("seeds")
    .select("id,artist,title,track_id,source,active")
    .eq("user_id", user.id);
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
  const directSeedByTrack = new Map(
    userSeeds.filter((seed: any) => seed.active && seed.track_id).map((seed: any) => [seed.track_id, seed]),
  );
  const appearanceEpisodesByTrack = new Map<string, string[]>();
  for (const appearance of appearanceResult.data || []) {
    if (!appearance.track_id || !appearance.episode_id) continue;
    const episodeIdsForTrack = appearanceEpisodesByTrack.get(appearance.track_id) || [];
    if (!episodeIdsForTrack.includes(appearance.episode_id)) episodeIdsForTrack.push(appearance.episode_id);
    appearanceEpisodesByTrack.set(appearance.track_id, episodeIdsForTrack);
  }

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
    const candidateEpisodeIds = Array.from(new Set([
      ...(track.episode_id ? [track.episode_id] : []),
      ...(appearanceEpisodesByTrack.get(track.id) || []),
    ]));
    const lineageEpisodeId = candidateEpisodeIds.find((episodeId) => lineageMap.get(episodeId)?.requested)
      || candidateEpisodeIds.find((episodeId) => lineageMap.get(episodeId)?.matchType === "full")
      || candidateEpisodeIds.find((episodeId) => lineageMap.has(episodeId));
    const lineage = lineageEpisodeId ? lineageMap.get(lineageEpisodeId) : undefined;
    track.seed_track = seedTrackMap.get(track.seed_track_id) || null;
    const contextEpisodeId = lineageEpisodeId || track.episode_id || candidateEpisodeIds[0];
    track.episode = episodeMap.get(contextEpisodeId) || null;
    track._match_type = lineage?.matchType || null;
    track._seed_name = lineage ? `${lineage.seed.artist} — ${lineage.seed.title}` : undefined;
    track._seed_artist = lineage?.seed.artist;
    track._seed_title = lineage?.seed.title;
    const directSeed = directSeedByTrack.get(track.id);
    track.is_seed = Boolean(directSeed && directSeed.source !== "re-seed");
    track.is_re_seed = directSeed?.source === "re-seed";
    track.is_artist_seed = track.is_artist_seed ?? false;
    const meta = (track.metadata || {}) as Record<string, unknown>;
    track._score_components = (meta._score_components as Record<string, number>) || {};
    track._ranked_score = track.taste_score ?? 0;
    track._sonic_seed_name = (meta._sonic_seed_name as string | undefined) || null;
    track._sonic_similarity = Number(meta._sonic_similarity ?? 0) || null;

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
  await signOptionalExplorationAudio(seriesExploration, async (storagePath) => {
    const { data: signed, error } = await db.storage.from("tracks").createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return signed?.signedUrl || null;
  });
  const withSeriesExploration = paceTracks(injectSeriesExploration(diversified, seriesExploration));

  const generationResult = await db.from("user_fyp_generations")
    .select("generation,reason,seed_id,updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (generationResult.error) {
    return NextResponse.json({ error: generationResult.error.message }, { status: 500 });
  }
  const generation = generationResult.data || {
    generation: 0,
    reason: "ranking_refresh",
    seed_id: null,
    updated_at: null,
  };

  const tangentResult = await db.from("user_fyp_tangents")
    .select("id,seed_id,seed_artist,seed_title,generation,track_ids,added_track_ids,moved_track_ids,removed_track_ids,track_snapshots,removed_track_snapshots,start_rank,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (tangentResult.error) {
    return NextResponse.json({ error: tangentResult.error.message }, { status: 500 });
  }
  const tangentRows = tangentResult.data || [];
  const tangents = tangentRows.map((row: any) => ({
    id: row.id,
    seed_id: row.seed_id,
    seed_name: `${row.seed_artist} — ${row.seed_title}`,
    generation: Number(row.generation),
    start_rank: row.start_rank,
    added_track_ids: row.added_track_ids || [],
    moved_track_ids: row.moved_track_ids || [],
    removed_track_ids: row.removed_track_ids || [],
    tracks: row.track_snapshots || [],
    removed_tracks: row.removed_track_snapshots || [],
    created_at: row.created_at,
  }));
  const latestTangent = tangents[0] || null;
  if (latestTangent) {
    const latestTangentTrackIds = new Set(latestTangent.tracks.map((track: any) => track.id));
    const displayedRanks = withSeriesExploration
      .map((track, index) => latestTangentTrackIds.has(track.id) ? index + 1 : null)
      .filter((rank): rank is number => rank !== null);
    if (displayedRanks.length) latestTangent.start_rank = Math.min(...displayedRanks);
    for (const track of withSeriesExploration) {
      if (!latestTangentTrackIds.has(track.id)) continue;
      track._tangent_id = latestTangent.id;
      track._tangent_seed_name = latestTangent.seed_name;
      track._tangent_start_rank = latestTangent.start_rank;
    }
  }

  if (shouldExplore && Number(generation.generation || 0) > 0) {
    const displayedExposureTracks = withSeriesExploration.map((track, index) => ({
      ...track,
      _display_rank: index + 1,
    }));
    const exposureRows = buildRankingExposureRows(
      user.id,
      Number(generation.generation),
      displayedExposureTracks,
    );
    if (exposureRows.length) {
      const exposureResult = await db.from("ranking_exposures").upsert(exposureRows, {
        onConflict: "user_id,request_id,track_id",
        ignoreDuplicates: true,
      });
      // Ranking measurement must never take the listening queue down.
      if (exposureResult.error) console.error("[fyp] ranking exposure logging failed:", exposureResult.error.message);
    }
  }

  // `total` describes the actual personalized page queue. The previous global
  // count included other users' already-actioned rows and was not an FYP count.
  return NextResponse.json({
    tracks: withSeriesExploration,
    total: withSeriesExploration.length,
    generation,
    tangents,
  });
}
