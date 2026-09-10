import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function cleanText(value: unknown, max = 5000): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from("segundo_sol_episodes")
    .select("*, segundo_sol_episode_tracks(id), segundo_sol_inspirations(id)")
    .eq("user_id", user.id)
    .order("episode_number", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const episodes = (data || []).map((episode: any) => ({
    ...episode,
    track_count: episode.segundo_sol_episode_tracks?.length || 0,
    inspiration_count: episode.segundo_sol_inspirations?.length || 0,
    segundo_sol_episode_tracks: undefined,
    segundo_sol_inspirations: undefined,
  }));

  return NextResponse.json({ episodes });
}

export async function POST(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const db = getServiceClient();
  let episodeNumber = Number(body.episode_number);

  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    const { data: latest, error: latestError } = await db
      .from("segundo_sol_episodes")
      .select("episode_number")
      .eq("user_id", user.id)
      .order("episode_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) return NextResponse.json({ error: latestError.message }, { status: 500 });
    episodeNumber = (latest?.episode_number || 0) + 1;
  }

  const title = cleanText(body.title, 200) || `Segundo Sol Sessions #${episodeNumber}`;
  const { data, error } = await db
    .from("segundo_sol_episodes")
    .insert({
      user_id: user.id,
      episode_number: episodeNumber,
      title,
      theme: cleanText(body.theme, 500),
      notes: cleanText(body.notes),
      status: ["draft", "assembling", "ready", "published"].includes(body.status)
        ? body.status
        : "draft",
    })
    .select("*")
    .single();

  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    return NextResponse.json({ error: error.code === "23505" ? "That episode number already exists" : error.message }, { status });
  }
  return NextResponse.json({ episode: { ...data, track_count: 0, inspiration_count: 0 } }, { status: 201 });
}
