import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { detectMusicPlatform, normalizeMusicUrl } from "@/lib/segundo-sol";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { id: string; trackId: string } };

function text(value: unknown, max = 3000): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export async function PATCH(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

  if ("artist" in body) updates.artist = text(body.artist, 300) || "Unknown artist";
  if ("title" in body) updates.title = text(body.title, 300) || "Untitled track";
  if ("role" in body) updates.role = text(body.role, 120);
  if ("notes" in body) updates.notes = text(body.notes);
  if ("artwork_url" in body) updates.artwork_url = text(body.artwork_url, 2000);
  if ("position" in body) {
    const position = Number(body.position);
    if (!Number.isInteger(position) || position < 0) {
      return NextResponse.json({ error: "Position must be zero or greater" }, { status: 400 });
    }
    updates.position = position;
  }
  if ("source_url" in body) {
    const normalized = normalizeMusicUrl(body.source_url);
    if (!normalized) return NextResponse.json({ error: "Unsupported music URL" }, { status: 400 });
    updates.source_url = normalized;
    updates.source_type = detectMusicPlatform(normalized);
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const { data, error } = await getServiceClient()
    .from("segundo_sol_episode_tracks")
    .update(updates)
    .eq("id", params.trackId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();

  if (error) {
    const duplicate = error.code === "23505";
    return NextResponse.json({ error: duplicate ? "That source is already in this episode" : error.message }, { status: duplicate ? 409 : 500 });
  }
  if (!data) return NextResponse.json({ error: "Track not found" }, { status: 404 });
  return NextResponse.json({ track: data });
}

export async function DELETE(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await getServiceClient()
    .from("segundo_sol_episode_tracks")
    .delete()
    .eq("id", params.trackId)
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Track not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
