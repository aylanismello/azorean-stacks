import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: { id: string } };

function cleanText(value: unknown, max = 5000): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

export async function GET(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getServiceClient();

  const [{ data: episode, error }, { data: tracks }, { data: inspirations }] = await Promise.all([
    db.from("segundo_sol_episodes").select("*").eq("id", params.id).eq("user_id", user.id).maybeSingle(),
    db.from("segundo_sol_episode_tracks").select("*, tracks(storage_path)").eq("episode_id", params.id).eq("user_id", user.id).order("position"),
    db.from("segundo_sol_inspirations").select("*").eq("episode_id", params.id).eq("user_id", user.id).order("position"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const episodeTracks = (tracks || []).map((row: Record<string, any>) => {
    const { tracks: backingTrack, ...track } = row;
    const hasBackingAudio = Boolean(backingTrack?.storage_path);
    return {
      ...track,
      playable: Boolean(track.audio_storage_path || hasBackingAudio),
      audio_status: track.audio_storage_path
        ? track.audio_status
        : hasBackingAudio
          ? "reused"
          : track.audio_status,
    };
  });
  return NextResponse.json({ episode: { ...episode, tracks: episodeTracks, inspirations: inspirations || [] } });
}

export async function PATCH(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

  if ("episode_number" in body) {
    const number = Number(body.episode_number);
    if (!Number.isInteger(number) || number < 1) {
      return NextResponse.json({ error: "Episode number must be a positive integer" }, { status: 400 });
    }
    updates.episode_number = number;
  }
  if ("title" in body) updates.title = cleanText(body.title, 200) || "Untitled episode";
  if ("theme" in body) updates.theme = cleanText(body.theme, 500);
  if ("notes" in body) updates.notes = cleanText(body.notes);
  if ("artwork_url" in body) updates.artwork_url = cleanText(body.artwork_url, 2000);
  if ("artwork_storage_path" in body) updates.artwork_storage_path = cleanText(body.artwork_storage_path, 1000);
  if ("status" in body) {
    if (!["draft", "assembling", "ready", "published"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const db = getServiceClient();
  let previousArtworkPath: string | null = null;
  if ("artwork_storage_path" in updates) {
    const { data: existing } = await db
      .from("segundo_sol_episodes")
      .select("artwork_storage_path")
      .eq("id", params.id)
      .eq("user_id", user.id)
      .maybeSingle();
    previousArtworkPath = existing?.artwork_storage_path || null;
  }

  const { data, error } = await db
    .from("segundo_sol_episodes")
    .update(updates)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();

  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    return NextResponse.json({ error: error.code === "23505" ? "That episode number already exists" : error.message }, { status });
  }
  if (!data) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  if (previousArtworkPath && previousArtworkPath !== data.artwork_storage_path) {
    await db.storage.from("segundo-sol-artwork").remove([previousArtworkPath]);
  }
  return NextResponse.json({ episode: data });
}

export async function DELETE(req: NextRequest, { params }: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data: episode, error: lookupError } = await db
    .from("segundo_sol_episodes")
    .select("id, artwork_storage_path")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const { error } = await db
    .from("segundo_sol_episodes")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  let artworkCleanupWarning: string | null = null;
  if (episode.artwork_storage_path) {
    const { error: storageError } = await db.storage
      .from("segundo-sol-artwork")
      .remove([episode.artwork_storage_path]);
    artworkCleanupWarning = storageError?.message || null;
  }
  return NextResponse.json({ deleted: true, artwork_cleanup_warning: artworkCleanupWarning });
}
