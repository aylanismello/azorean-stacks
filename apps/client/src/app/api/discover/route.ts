import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

const ACTIVE_STATES = new Set(["queued", "discovering", "enriching", "preparing", "downloading"]);

/**
 * Backward-compatible discovery trigger.
 *
 * Discovery itself belongs to the durable local priority worker. The hosted
 * request only queues one fenced seed generation; it never crawls or imports
 * source data in parallel with that worker.
 */
export async function POST(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let seedId: string | undefined;
  try {
    ({ seed_id: seedId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!seedId) return NextResponse.json({ error: "seed_id is required" }, { status: 400 });

  const db = getServiceClient();
  const { data: seed, error } = await db.from("seeds")
    .select("id,active,pipeline_status,fyp_refresh_required_at")
    .eq("id", seedId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!seed) return NextResponse.json({ error: "Seed not found" }, { status: 404 });
  if (!seed.active) return NextResponse.json({ error: "Seed is inactive" }, { status: 409 });

  const currentStatus = seed.pipeline_status as Record<string, unknown> | null;
  const currentState = typeof currentStatus?.state === "string" ? currentStatus.state : null;
  if (currentState && ACTIVE_STATES.has(currentState)) {
    return NextResponse.json({
      queued: true,
      state: currentState,
      tracks_found: 0,
      tracks_new: 0,
      tracks_existing: 0,
      user_tracks_created: 0,
    }, { status: 202 });
  }

  const now = new Date();
  const { data: queued, error: queueError } = await db.from("seeds")
    .update({
      pipeline_status: {
        state: "queued",
        started_at: now.toISOString(),
        log: [{ t: now.toTimeString().slice(0, 8), msg: "discovery queued" }],
      },
      fyp_refresh_required_at: now.toISOString(),
      fyp_refreshed_at: null,
      fyp_refresh_claimed_at: null,
    })
    .eq("id", seedId)
    .eq("user_id", user.id)
    .eq("active", true)
    .select("id")
    .maybeSingle();
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });
  if (!queued) return NextResponse.json({ error: "Seed changed before it could be queued" }, { status: 409 });

  return NextResponse.json({
    queued: true,
    state: "queued",
    tracks_found: 0,
    tracks_new: 0,
    tracks_existing: 0,
    user_tracks_created: 0,
  }, { status: 202 });
}
