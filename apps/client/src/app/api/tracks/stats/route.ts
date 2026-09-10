import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/tracks/stats — per-user library counts in one bounded response.
export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const counts = {
    super_liked: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    skipped: 0,
    listened: 0,
    bad_source: 0,
  };

  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("user_tracks")
      .select("status,super_liked")
      .eq("user_id", user.id)
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    for (const row of data || []) {
      if (row.super_liked) counts.super_liked++;
      if (row.status in counts && row.status !== "super_liked") {
        counts[row.status as keyof typeof counts]++;
      }
    }
    if (!data || data.length < 1000) break;
  }

  return NextResponse.json({
    ...counts,
    total: counts.approved + counts.pending + counts.rejected + counts.skipped + counts.listened + counts.bad_source,
  });
}
