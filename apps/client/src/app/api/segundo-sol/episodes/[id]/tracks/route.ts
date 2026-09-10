import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { detectMusicPlatform, normalizeMusicUrl } from "@/lib/segundo-sol";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function text(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

async function ownsEpisode(userId: string, episodeId: string): Promise<boolean> {
  const { data } = await getServiceClient()
    .from("segundo_sol_episodes")
    .select("id")
    .eq("id", episodeId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

function preferredTrackUrl(track: Record<string, any>): string | null {
  return track.spotify_url || track.soundcloud_url || track.bandcamp_url || track.youtube_url || track.source_url || null;
}

export async function POST(req: NextRequest, props: Context) {
  const params = await props.params;
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await ownsEpisode(user.id, params.id))) {
    return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const db = getServiceClient();
  let payload: Record<string, any>;

  if (typeof body.track_id === "string" && body.track_id) {
    const { data: userTrack, error: userTrackError } = await db
      .from("user_tracks")
      .select("track_id, status, super_liked, voted_at")
      .eq("user_id", user.id)
      .eq("track_id", body.track_id)
      .eq("status", "approved")
      .maybeSingle();
    if (userTrackError) return NextResponse.json({ error: userTrackError.message }, { status: 500 });
    if (!userTrack) return NextResponse.json({ error: "Track is not in your kept library" }, { status: 403 });

    const { data: track, error: trackError } = await db
      .from("tracks")
      .select("*")
      .eq("id", body.track_id)
      .single();
    if (trackError || !track) return NextResponse.json({ error: trackError?.message || "Track not found" }, { status: 404 });

    payload = {
      track_id: track.id,
      artist: track.artist,
      title: track.title,
      source_origin: userTrack.super_liked ? "stacks_super_like" : "stacks_like",
      source_type: "stacks",
      source_url: preferredTrackUrl(track),
      artwork_url: track.cover_art_url || null,
      metadata: {
        source: track.source,
        source_context: track.source_context,
        spotify_url: track.spotify_url || null,
        soundcloud_url: track.soundcloud_url || null,
        bandcamp_url: track.bandcamp_url || null,
        youtube_url: track.youtube_url || null,
        original_source_url: track.source_url || null,
        vote_status: userTrack.status,
        super_liked: Boolean(userTrack.super_liked),
        voted_at: userTrack.voted_at || null,
        bpm: Number.isFinite(Number(track.metadata?.bpm)) ? Number(track.metadata.bpm) : null,
        bpm_source: Number.isFinite(Number(track.metadata?.bpm)) ? "stacks_metadata" : null,
        snapshot_at: new Date().toISOString(),
      },
    };
  } else {
    const sourceUrl = typeof body.source_url === "string" ? normalizeMusicUrl(body.source_url) : null;
    const artist = text(body.artist, 300);
    const title = text(body.title, 300);
    if (!sourceUrl || !title) {
      return NextResponse.json({ error: "Manual tracks need a supported music URL and title" }, { status: 400 });
    }
    payload = {
      track_id: null,
      artist: artist || "Unknown artist",
      title,
      source_origin: "manual",
      source_type: detectMusicPlatform(sourceUrl),
      source_url: sourceUrl,
      artwork_url: text(body.artwork_url, 2000),
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {},
    };
  }

  const { data: last } = await db
    .from("segundo_sol_episode_tracks")
    .select("position")
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  payload = {
    ...payload,
    episode_id: params.id,
    user_id: user.id,
    position: (last?.position ?? -1) + 1,
    role: text(body.role, 120),
    notes: text(body.notes, 3000),
  };

  const { data, error } = await db
    .from("segundo_sol_episode_tracks")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    const duplicate = error.code === "23505";
    return NextResponse.json(
      { error: duplicate ? "That track is already in this episode" : error.message },
      { status: duplicate ? 409 : 500 }
    );
  }
  return NextResponse.json({ track: data }, { status: 201 });
}
