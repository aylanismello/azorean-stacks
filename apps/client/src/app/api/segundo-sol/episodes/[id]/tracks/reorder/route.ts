import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, props: Context) {
  const params = await props.params;
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const trackIds = Array.isArray(body.track_ids) ? body.track_ids : null;
  if (
    !trackIds ||
    trackIds.length > 500 ||
    trackIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(trackIds).size !== trackIds.length
  ) {
    return NextResponse.json({ error: "track_ids must be a unique UUID array" }, { status: 400 });
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

  const { data: tracks, error: tracksError } = await db
    .from("segundo_sol_episode_tracks")
    .select("*")
    .eq("episode_id", params.id)
    .eq("user_id", user.id);
  if (tracksError) return NextResponse.json({ error: tracksError.message }, { status: 500 });

  const rows = tracks || [];
  const ownedIds = new Set(rows.map((track) => track.id));
  if (trackIds.length !== rows.length || trackIds.some((id: string) => !ownedIds.has(id))) {
    return NextResponse.json({ error: "Track order must include every episode track exactly once" }, { status: 400 });
  }

  const positionById = new Map(trackIds.map((id: string, position: number) => [id, position]));
  const reordered = rows.map((track) => ({ ...track, position: positionById.get(track.id) }));
  const { error: updateError } = await db
    .from("segundo_sol_episode_tracks")
    .upsert(reordered, { onConflict: "id" });
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ reordered: true });
}
