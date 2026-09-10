import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { detectMusicPlatform, normalizeMusicUrl } from "@/lib/segundo-sol";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sourceUrl = typeof body.source_url === "string" ? normalizeMusicUrl(body.source_url) : null;
  if (!sourceUrl) {
    return NextResponse.json({ error: "Use a supported HTTPS Spotify, SoundCloud, Bandcamp, or YouTube URL" }, { status: 400 });
  }
  const sourceType = detectMusicPlatform(sourceUrl);
  if (!["spotify", "soundcloud", "bandcamp", "youtube"].includes(sourceType)) {
    return NextResponse.json({ error: "That source is not supported for track imports" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: episode, error: episodeError } = await db
    .from("segundo_sol_episodes")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (episodeError) return NextResponse.json({ error: episodeError.message }, { status: 500 });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const { data, error } = await db
    .from("segundo_sol_import_jobs")
    .insert({
      episode_id: params.id,
      user_id: user.id,
      source_url: sourceUrl,
      source_type: sourceType,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: data }, { status: 202 });
}
