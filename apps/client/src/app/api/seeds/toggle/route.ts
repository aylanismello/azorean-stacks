import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/seeds/toggle — create or remove a re-seed for a track
export async function POST(req: NextRequest) {
  const db = getServiceClient();
  const { track_id, artist, title, action } = await req.json();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Route only needs read access to auth cookies here.
        },
      },
    }
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!track_id || !artist || !title) {
    return NextResponse.json({ error: "track_id, artist and title required" }, { status: 400 });
  }
  if (action !== "ensure" && action !== "toggle") {
    return NextResponse.json({ error: "action must be ensure or toggle" }, { status: 400 });
  }

  // Re-seeds are stored as user-owned seed rows so they don't collide with shared base seeds.
  let existingSeed: { id: string } | null = null;

  if (track_id) {
    const { data } = await db
      .from("seeds")
      .select("id")
      .eq("user_id", user.id)
      .eq("track_id", track_id)
      .limit(1)
      .maybeSingle();
    existingSeed = data;
  }

  if (!existingSeed) {
    const escArtist = artist.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const escTitle = title.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const { data } = await db
      .from("seeds")
      .select("id")
      .eq("user_id", user.id)
      .eq("source", "re-seed")
      .ilike("artist", escArtist)
      .ilike("title", escTitle)
      .limit(1)
      .maybeSingle();
    existingSeed = data;
  }

  if (existingSeed) {
    if (action === "ensure") {
      return NextResponse.json({ action: "existing", seed_id: existingSeed.id });
    }
    const { data: removed, error } = await db.rpc("delete_owned_seed", {
      p_seed_id: existingSeed.id,
      p_user_id: user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!removed) return NextResponse.json({ error: "Seed not found" }, { status: 404 });
    return NextResponse.json({ action: "removed", seed_id: existingSeed.id });
  }

  // Create new re-seed
  const now = new Date();
  const { data: newSeedId, error } = await db.rpc("create_reseed", {
    p_user_id: user.id,
    p_track_id: track_id,
    p_artist: artist.trim(),
    p_title: title.trim(),
    p_now: now.toISOString(),
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(
    {
      action: "created",
      seed_id: newSeedId,
      queued: true,
    },
    { status: 201 }
  );
}
