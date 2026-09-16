import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { getPersonalizedCandidateTrackSummaries } from "@/lib/fyp-personalization";
import { genreFeedCounts, seedFeedCount, type FeedAppearance } from "@/lib/filtered-feed-preparation";
import { hasExactArtistCredits, seedMatchEvidence } from "@/lib/seed-match-evidence";

export const dynamic = "force-dynamic";

// GET /api/stacks — seeds with their episodes and per-episode track stats
export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only access to auth cookies in route handlers.
        },
      },
    }
  );
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Only expose seeds the destination feed can authorize for this user.
  const { data: seeds, error: seedErr } = await supabase
    .from("seeds")
    .select("id, track_id, artist, title, active, cover_art_url, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (seedErr) {
    return NextResponse.json({ error: seedErr.message }, { status: 500 });
  }

  const seedIds = (seeds || []).map((s) => s.id);
  if (seedIds.length === 0) {
    return NextResponse.json({ stacks: [], total_pending: 0 });
  }

  // 2. Get episode_seeds links with episode info
  const { data: episodeLinks } = await supabase
    .from("episode_seeds")
    .select("seed_id, match_type, episodes(id, title, url, source, aired_date, skipped)")
    .in("seed_id", seedIds)
    .in("match_type", ["full", "artist"]);

  // Build seed → episodes map
  const episodesBySeed: Record<string, Array<{
    id: string; title: string | null; url: string; source: string;
    aired_date: string | null; skipped: boolean; match_type: string;
  }>> = {};

  const allEpisodeIds = new Set<string>();

  for (const link of (episodeLinks || []) as any[]) {
    if (!link.episodes) continue;
    const ep = link.episodes;
    allEpisodeIds.add(ep.id);
    if (!episodesBySeed[link.seed_id]) episodesBySeed[link.seed_id] = [];
    episodesBySeed[link.seed_id].push({
      id: ep.id,
      title: ep.title,
      url: ep.url,
      source: ep.source,
      aired_date: ep.aired_date,
      skipped: ep.skipped || false,
      match_type: link.match_type || "unknown",
    });
  }

  // Render the stack grid after only the seed and episode-link reads. The
  // heavier personalized/catalog counts replace this response in the client.
  if (req.nextUrl.searchParams.get("view") === "base") {
    const stacks = (seeds || []).map((seed) => {
      const episodes = (episodesBySeed[seed.id] || []).filter((episode) => !episode.skipped);
      return {
        id: seed.id,
        artist: seed.artist,
        title: seed.title,
        active: seed.active,
        episodes,
        cover_art_url: seed.cover_art_url || null,
        has_exact_match: episodes.some((episode) => episode.match_type === "full"),
        counts_loading: true,
        total_pending: 0,
        total_approved: 0,
        total_rejected: 0,
        total: 0,
        total_playable: 0,
        total_processing: 0,
        total_unavailable: 0,
        eligible_queue_tracks: 0,
        ready_queue_tracks: 0,
      };
    }).filter((stack) => stack.episodes.length > 0);
    return NextResponse.json({ stacks, total_pending: 0, partial: true });
  }

  // Use the same personalized eligibility and episode appearance membership as
  // the queue endpoint. Catalog totals remain available but are not presented
  // as if every catalog appearance can play in this user's stack.
  const hideLow = req.nextUrl.searchParams.get("hide_low") === "true";
  let candidates: any[];
  try {
    candidates = await getPersonalizedCandidateTrackSummaries(supabase, user.id, hideLow);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load stack candidates" }, { status: 500 });
  }
  const genres = [...genreFeedCounts(candidates).entries()]
    .filter(([, count]) => count.eligible > 0)
    .sort((a, b) => b[1].eligible - a[1].eligible || a[0].localeCompare(b[0]))
    .map(([genre, count]) => ({
      genre,
      pending: count.eligible,
      eligible: count.eligible,
      ready: count.ready,
    }));

  if (allEpisodeIds.size === 0) {
    return NextResponse.json({
      stacks: (seeds || []).map((s) => ({ ...s, episodes: [], total_pending: 0, total_approved: 0, total_rejected: 0, total: 0, total_playable: 0, total_processing: 0, total_unavailable: 0, eligible_queue_tracks: 0, ready_queue_tracks: 0 })),
      genres,
      total_pending: 0,
    });
  }
  const appearances: FeedAppearance[] = [];
  for (let appearancePage = 0; ; appearancePage++) {
    const { data: batch, error } = await supabase.from("episode_tracks")
      .select("episode_id,track_id,track:tracks!inner(id,status,cover_art_url,artist,title,source_url,source_context,storage_path,spotify_url,youtube_url)")
      .in("episode_id", Array.from(allEpisodeIds))
      .range(appearancePage * 1000, (appearancePage + 1) * 1000 - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!batch || batch.length === 0) break;
    appearances.push(...batch as FeedAppearance[]);
    if (batch.length < 1000) break;
  }

  // 3. Build per-episode appearance rows from the canonical junction. A track's
  // legacy tracks.episode_id points only to its first-discovered episode.
  const tracks = (appearances as any[]).flatMap((appearance) => {
    const track = Array.isArray(appearance.track) ? appearance.track[0] : appearance.track;
    return track ? [{ ...track, episode_id: appearance.episode_id }] : [];
  });

  // Get user's votes for these tracks
  const allTrackIds = tracks.map((t: any) => t.id);
  const userVoteMap = new Map<string, string>();
  if (allTrackIds.length > 0) {
    let votePage = 0;
    while (true) {
      const pageIds = allTrackIds.slice(votePage * 1000, (votePage + 1) * 1000);
      if (pageIds.length === 0) break;
      const { data: batch } = await supabase
        .from("user_tracks")
        .select("track_id, status")
        .eq("user_id", user.id)
        .in("track_id", pageIds);
      if (batch) {
        for (const v of batch as any[]) {
          userVoteMap.set(v.track_id, v.status);
        }
      }
      votePage++;
      if (pageIds.length < 1000) break;
    }
  }

  // Keep a same-artist cover fallback for the seed card.
  const artistCoverArt: Record<string, string> = {};
  for (const t of (tracks || []) as any[]) {
    if (!t.episode_id) continue;
    const artistLower = (t.artist || "").toLowerCase();
    if (t.cover_art_url && !artistCoverArt[artistLower]) {
      artistCoverArt[artistLower] = t.cover_art_url;
    }
  }

  const statsForSeedEpisode = (episodeId: string, seedArtist: string) => {
    const episodeTracks = (tracks || []).filter((track: any) => track.episode_id === episodeId);
    const matchingTracks = (tracks || []).filter((track: any) =>
      track.episode_id === episodeId
      && track.artist
      && hasExactArtistCredits(track.artist, seedArtist)
    );
    const stats = {
      pending: 0,
      approved: 0,
      rejected: 0,
      total: 0,
      playable: 0,
      processing: 0,
      unavailable: 0,
      cover_art_url: null as string | null,
      sample_tracks: [] as { artist: string; title: string }[],
    };
    for (const track of episodeTracks) {
      stats.total++;
      if (track.storage_path) stats.playable++;
      const userVote = userVoteMap.get(track.id);
      const effectiveStatus = userVote && userVote !== "pending" ? userVote : track.status;
      if (effectiveStatus === "approved") stats.approved++;
      else if (effectiveStatus === "rejected") stats.rejected++;
      else if (effectiveStatus === "pending") stats.pending++;
      if (track.status === "pending" && !track.storage_path) stats.processing++;
      if (track.status === "skipped" || track.status === "failed"
          || (track.status !== "pending" && track.status !== "approved"
            && track.status !== "rejected" && !track.storage_path)) {
        stats.unavailable++;
      }
      if (!stats.cover_art_url && track.cover_art_url) stats.cover_art_url = track.cover_art_url;
      if (stats.sample_tracks.length < 3 && (!userVote || userVote === "pending")) {
        stats.sample_tracks.push({ artist: track.artist, title: track.title });
      }
    }
    return { stats, matchingTracks };
  };

  // 5. Build response: seeds with enriched episodes
  let globalPending = 0;

  const stacks = (seeds || []).map((seed) => {
    const seedArtistLower = (seed.artist || "").toLowerCase();
    const linkedEpisodes = episodesBySeed[seed.id] || [];
    const linkedEpisodeIds = new Set(linkedEpisodes.map((episode) => episode.id));
    const eligibleAppearances = (appearances as any[]).filter((appearance) =>
      linkedEpisodeIds.has(appearance.episode_id)
    );
    const eps = linkedEpisodes
      .filter((ep) => !ep.skipped)
      .map((ep) => {
        const { stats, matchingTracks } = statsForSeedEpisode(ep.id, seed.artist);
        const evidence = seedMatchEvidence(seed.artist, seed.title, matchingTracks);
        // For artist-only matches, show the tracks with the seed's exact artist credit set.
        const matched_tracks = evidence?.matchType !== "full"
          ? matchingTracks.slice(0, 5).map((track: any) => ({ artist: track.artist, title: track.title }))
          : [];
        return { ...ep, match_type: evidence?.matchType || "unknown", ...stats, matched_tracks };
      })
      .filter((ep) => ep.total > 0)
      .sort((a, b) => b.pending - a.pending); // pending-heavy first

    const totalPending = eps.reduce((s, e) => s + e.pending, 0);
    const totalApproved = eps.reduce((s, e) => s + e.approved, 0);
    const totalRejected = eps.reduce((s, e) => s + e.rejected, 0);
    const total = eps.reduce((s, e) => s + e.total, 0);
    const totalPlayable = eps.reduce((s, e) => s + e.playable, 0);
    const totalProcessing = eps.reduce((s, e) => s + e.processing, 0);
    const totalUnavailable = eps.reduce((s, e) => s + e.unavailable, 0);
    const feedCount = seedFeedCount(
      candidates,
      eps.map((episode) => episode.id),
      eligibleAppearances,
      seed.track_id,
    );
    globalPending += totalPending;

    // Use the seed's own cover art (from Spotify lookup of the seed song itself)
    // Fall back to cover art from a track by the SAME artist (not random episode art)
    // If no same-artist art exists, return null → UI shows gradient fallback
    const cover_art_url = seed.cover_art_url || artistCoverArt[seedArtistLower] || null;

    const has_exact_match = eps.some((e) => e.match_type === "full");

    return {
      id: seed.id,
      artist: seed.artist,
      title: seed.title,
      active: seed.active,
      episodes: eps,
      total_pending: totalPending,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      total,
      total_playable: totalPlayable,
      total_processing: totalProcessing,
      total_unavailable: totalUnavailable,
      eligible_queue_tracks: feedCount.eligible,
      ready_queue_tracks: feedCount.ready,
      cover_art_url,
      has_exact_match,
    };
  })
    .filter((s) => s.episodes.length > 0); // Only seeds with episodes
    // Seeds are already sorted by created_at desc from the DB query (newest first)

  return NextResponse.json({ stacks, genres, total_pending: globalPending });
}
