import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; trackId: string }> };

export async function GET(req: NextRequest, props: Context) {
  const params = await props.params;
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data: track, error } = await db
    .from("segundo_sol_episode_tracks")
    .select("id,artist,title,audio_storage_path,audio_status,audio_error,tracks(storage_path)")
    .eq("id", params.trackId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });
  const backingTrack = Array.isArray(track.tracks) ? track.tracks[0] : track.tracks;
  const storagePath = track.audio_storage_path || backingTrack?.storage_path || null;
  const bucket = track.audio_storage_path ? "segundo-sol-audio" : "tracks";
  if (!storagePath) {
    return NextResponse.json({
      status: track.audio_status,
      error: track.audio_status === "failed"
        ? track.audio_error || "Audio preparation failed"
        : null,
    }, { status: 202 });
  }

  const { data: signed, error: signError } = await db.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);
  if (signError || !signed) {
    return NextResponse.json({ error: signError?.message || "Could not serve audio" }, { status: 500 });
  }

  const filename = `${track.artist} - ${track.title}.mp3`.replace(/[/\\?%*:|"<>]/g, "");
  return NextResponse.json({ url: signed.signedUrl, filename });
}

export async function POST(req: NextRequest, props: Context) {
  const params = await props.params;
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data: track, error: trackError } = await db
    .from("segundo_sol_episode_tracks")
    .select("id, source_url, audio_status")
    .eq("id", params.trackId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (trackError) return NextResponse.json({ error: trackError.message }, { status: 500 });
  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });
  if (!track.source_url) return NextResponse.json({ error: "Track has no downloadable source" }, { status: 400 });
  if (["pending", "processing"].includes(track.audio_status)) {
    return NextResponse.json({ queued: true, status: track.audio_status }, { status: 202 });
  }

  const { data: request, error } = await db
    .from("segundo_sol_download_requests")
    .insert({
      episode_id: params.id,
      episode_track_id: params.trackId,
      user_id: user.id,
      source_url: track.source_url,
      status: "pending",
    })
    .select("id, status")
    .single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "Download already queued" : error.message }, { status: error.code === "23505" ? 409 : 500 });

  const { error: updateError } = await db
    .from("segundo_sol_episode_tracks")
    .update({ audio_status: "pending", audio_error: null, audio_requested_at: new Date().toISOString() })
    .eq("id", params.trackId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ queued: true, request }, { status: 202 });
}
