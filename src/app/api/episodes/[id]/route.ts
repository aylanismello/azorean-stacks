import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

// PATCH /api/episodes/[id] — update episode (e.g. mark as skipped)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = getServiceClient();
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};

  if (typeof body.skipped === "boolean") {
    updates.skipped = body.skipped;
    updates.skipped_at = body.skipped ? new Date().toISOString() : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("episodes")
    .update(updates)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // When skipping, reject all pending tracks from this episode
  if (body.skipped) {
    const now = new Date().toISOString();
    await supabase
      .from("tracks")
      .update({ status: "rejected", voted_at: now })
      .eq("episode_id", id)
      .eq("status", "pending");
  }

  return NextResponse.json({ ok: true });
}
