import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { detectMusicPlatform, normalizeMusicUrl } from "@/lib/segundo-sol";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { id: string } };

function text(value: unknown, max = 3000): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export async function POST(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getServiceClient();

  const { data: episode } = await db
    .from("segundo_sol_episodes")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const sourceUrl = typeof body.source_url === "string" ? normalizeMusicUrl(body.source_url) : null;
  const title = text(body.title, 500);
  if (!sourceUrl || !title) {
    return NextResponse.json({ error: "An enriched mix URL and title are required" }, { status: 400 });
  }

  const { data: last } = await db
    .from("segundo_sol_inspirations")
    .select("position")
    .eq("episode_id", params.id)
    .eq("user_id", user.id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await db
    .from("segundo_sol_inspirations")
    .insert({
      episode_id: params.id,
      user_id: user.id,
      position: (last?.position ?? -1) + 1,
      title,
      creator: text(body.creator, 300),
      source_type: detectMusicPlatform(sourceUrl),
      source_url: sourceUrl,
      artwork_url: text(body.artwork_url, 2000),
      notes: text(body.notes),
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {},
    })
    .select("*")
    .single();

  if (error) {
    const duplicate = error.code === "23505";
    return NextResponse.json({ error: duplicate ? "That inspiration is already attached" : error.message }, { status: duplicate ? 409 : 500 });
  }
  return NextResponse.json({ inspiration: data }, { status: 201 });
}
