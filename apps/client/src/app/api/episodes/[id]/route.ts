import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { canEditSharedCatalog, getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

// PATCH /api/episodes/[id] — update episode (e.g. mark as skipped)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canEditSharedCatalog(user.id)) {
    return NextResponse.json({ error: "Shared episode changes require catalog-editor access" }, { status: 403 });
  }

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

  return NextResponse.json({ ok: true });
}
