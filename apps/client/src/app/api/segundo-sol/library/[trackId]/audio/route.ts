import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { trackId: string } };

export async function GET(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data: userTrack, error } = await db
    .from("user_tracks")
    .select("track_id, tracks!inner(storage_path, spotify_url, youtube_url)")
    .eq("user_id", user.id)
    .eq("track_id", params.trackId)
    .eq("status", "approved")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!userTrack) return NextResponse.json({ error: "Track is not in your kept library" }, { status: 404 });

  const backingTrack = Array.isArray(userTrack.tracks) ? userTrack.tracks[0] : userTrack.tracks;
  let audioUrl: string | null = null;
  if (backingTrack?.storage_path) {
    const { data: signed, error: signError } = await db.storage
      .from("tracks")
      .createSignedUrl(backingTrack.storage_path, 3600);
    if (signError) return NextResponse.json({ error: "Could not prepare this preview" }, { status: 500 });
    audioUrl = signed?.signedUrl || null;
  }

  return NextResponse.json({
    url: audioUrl,
    spotify_url: backingTrack?.spotify_url || null,
    youtube_url: backingTrack?.youtube_url || null,
  });
}
