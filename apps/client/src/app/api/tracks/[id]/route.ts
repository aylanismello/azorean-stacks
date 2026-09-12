import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { canEditSharedCatalog } from "@/lib/server-auth";
import { parseQualifiedListenEvidence } from "@/lib/listen-evidence";

export const dynamic = "force-dynamic";

function getAuthClient(req: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    }
  );
}

function isPendingPipelineMigration(error: { code?: string; message?: string }): boolean {
  const message = error.message || "";
  return (["42703", "PGRST204"].includes(error.code || "") && message.includes("user_id"))
    || (error.code === "PGRST202" && (
      message.includes("enqueue_corrected_download_request")
      || message.includes("record_qualified_track_listen")
    ));
}

// PATCH /api/tracks/[id] — update vote (writes to user_tracks ONLY, never tracks.status)
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = getServiceClient();
  const body = await req.json();
  const { status, super_liked, source_url } = body;

  // Auth required for all votes
  const authClient = getAuthClient(req);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();

  // Super Like: upsert user_tracks with super_liked=true + approved
  if (super_liked === true) {
    const { error: voteError } = await supabase
      .from("user_tracks")
      .upsert(
        { user_id: user.id, track_id: params.id, super_liked: true, status: "approved", voted_at: now },
        { onConflict: "user_id,track_id" }
      );
    if (voteError) return NextResponse.json({ error: voteError.message }, { status: 500 });
    const { error: outcomeError } = await authClient.rpc("record_ranking_outcome", {
      p_track_id: params.id,
      p_outcome: "approved",
    });
    if (outcomeError) console.error("[tracks] ranking outcome logging failed:", outcomeError.message);

    const { data: track, error } = await supabase
      .from("tracks")
      .select("*")
      .eq("id", params.id)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ...track, status: "approved", super_liked: true, voted_at: now });
  }

  // fix_source: a catalog editor provided a corrected URL — the local engine re-downloads it
  if (status === "fix_source" && source_url) {
    if (!canEditSharedCatalog(user)) {
      return NextResponse.json({ error: "Shared source corrections require catalog-editor access" }, { status: 403 });
    }

    let parsedSource: URL;
    try {
      parsedSource = new URL(source_url as string);
    } catch {
      return NextResponse.json({ error: "Invalid URL. Must be YouTube or SoundCloud." }, { status: 400 });
    }
    const allowedHosts = new Set(["youtube.com", "www.youtube.com", "youtu.be", "soundcloud.com", "m.soundcloud.com"]);
    const sourceHost = parsedSource.hostname.toLowerCase();
    if (parsedSource.protocol !== "https:" || !allowedHosts.has(sourceHost)) {
      return NextResponse.json({ error: "Invalid URL. Must be YouTube or SoundCloud." }, { status: 400 });
    }

    const isYoutube = ["youtube.com", "www.youtube.com", "youtu.be"].includes(sourceHost);

    // Fetch existing track data
    const { data: existing } = await supabase
      .from("tracks")
      .select("*, metadata, storage_path")
      .eq("id", params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // Keep the old object playable until the local worker replaces it. The
    // worker removes the superseded object only after the replacement lands.
    const updatedMeta = { ...(existing.metadata as Record<string, unknown> ?? {}) };
    if (!isYoutube) {
      updatedMeta.soundcloud_url = source_url;
    }
    updatedMeta.audio_source = isYoutube ? "youtube" : "soundcloud";

    const updatePayload = {
      youtube_url: isYoutube ? source_url : null,
      metadata: updatedMeta,
    };
    console.log(`[fix_source] Updating track ${params.id}:`, JSON.stringify(updatePayload));

    // Serialize corrections in PostgreSQL so concurrent requests cannot revive
    // a stale source or race the worker's fenced storage commit.
    const { error: dlReqErr } = await supabase.rpc("enqueue_corrected_download_request", {
      p_track_id: params.id,
      p_user_id: user.id,
      p_source_url: source_url as string,
    });
    if (dlReqErr) {
      if (isPendingPipelineMigration(dlReqErr)) {
        return NextResponse.json({
          error: "Source correction is temporarily unavailable while its database migration is applied",
        }, { status: 503 });
      }
      return NextResponse.json({ error: dlReqErr.message }, { status: 500 });
    }

    const { data: track, error } = await supabase
      .from("tracks")
      .update(updatePayload)
      .eq("id", params.id)
      .select("*")
      .single();

    if (error) {
      console.error(`[fix_source] Update failed for track ${params.id}:`, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ...track,
      queued: true,
      message: "Corrected source queued for local preparation.",
    }, { status: 202 });
  }

  if (!status || !["approved", "rejected", "pending", "skipped", "listened", "bad_source"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be: approved, rejected, pending, skipped, listened, bad_source" },
      { status: 400 }
    );
  }

  // 'listened' is a soft-skip: only set if no explicit vote exists yet
  if (status === "listened") {
    const evidence = parseQualifiedListenEvidence(body);
    if (!evidence) {
      return NextResponse.json({
        error: "listened requires integer listen_pct (80-100) and non-negative listen_duration_ms",
      }, { status: 400 });
    }

    // The RPC makes evidence + soft status one atomic upsert. Its conflict branch
    // preserves approved/rejected/skipped/bad_source if an explicit vote races it.
    const { data: persistedStatus, error: listenError } = await supabase.rpc(
      "record_qualified_track_listen",
      {
        p_user_id: user.id,
        p_track_id: params.id,
        p_listen_pct: evidence.listen_pct,
        p_listen_duration_ms: evidence.listen_duration_ms,
      },
    );
    if (listenError) {
      if (isPendingPipelineMigration(listenError)) {
        return NextResponse.json({
          error: "Qualified listen persistence is temporarily unavailable while its database migration is applied",
        }, { status: 503 });
      }
      return NextResponse.json({ error: listenError.message }, { status: 500 });
    }
    const { error: outcomeError } = await authClient.rpc("record_ranking_outcome", {
      p_track_id: params.id,
      p_outcome: "listened",
    });
    if (outcomeError) console.error("[tracks] ranking outcome logging failed:", outcomeError.message);

    const { data: track, error: trackErr } = await supabase
      .from("tracks")
      .select("*")
      .eq("id", params.id)
      .single();
    if (trackErr) return NextResponse.json({ error: trackErr.message }, { status: 500 });
    return NextResponse.json({ ...track, status: persistedStatus, ...evidence });
  }

  // All other votes: upsert to user_tracks only
  const votedAt = ["approved", "rejected", "skipped", "bad_source"].includes(status) ? now : undefined;

  const { error: upsertError } = await supabase
    .from("user_tracks")
    .upsert(
      {
        user_id: user.id,
        track_id: params.id,
        status,
        super_liked: false,
        ...(votedAt ? { voted_at: votedAt } : {}),
      },
      { onConflict: "user_id,track_id", ignoreDuplicates: false }
    );

  if (upsertError) {
    console.error(`Vote upsert failed for track ${params.id}:`, upsertError);
    return NextResponse.json({ error: `Vote failed: ${upsertError.message}` }, { status: 500 });
  }

  if (["approved", "rejected", "skipped"].includes(status)) {
    const { error: outcomeError } = await authClient.rpc("record_ranking_outcome", {
      p_track_id: params.id,
      p_outcome: status,
    });
    if (outcomeError) console.error("[tracks] ranking outcome logging failed:", outcomeError.message);
  }

  // Fetch track data to return
  const { data: track, error } = await supabase
    .from("tracks")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ...track, status, voted_at: votedAt || track.voted_at });
}

// GET /api/tracks/[id]
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const authClient = getAuthClient(req);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await props.params;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  return NextResponse.json(data);
}
