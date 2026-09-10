import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { diversifyTracks } from "@/lib/diversify";
import { loadPersonalizedFyp } from "@/lib/fyp-personalization";
import { parsePagination } from "@/lib/pagination";

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
  let rows: any[];
  try {
    rows = await loadPersonalizedFyp(db, user.id, {
      limit, offset, hideLow, seedId, genre, seedArtist,
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error && error.status === 404 ? 404 : 500;
    const message = error instanceof Error ? error.message : "Failed to load personalized FYP";
    return NextResponse.json({ error: message }, { status });
  }

  const seedTrackIds = Array.from(new Set(rows.map((t: any) => t.seed_track_id).filter(Boolean)));
  const episodeIds = Array.from(new Set(rows.map((t: any) => t.episode_id).filter(Boolean)));

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
    const directSeed = directSeedByTrack.get(track.id);
    track.is_seed = Boolean(directSeed && directSeed.source !== "re-seed");
    track.is_re_seed = directSeed?.source === "re-seed";
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

  // `total` describes the actual personalized page queue. The previous global
  // count included other users' already-actioned rows and was not an FYP count.
  return NextResponse.json({ tracks: diversified, total: diversified.length });
}
