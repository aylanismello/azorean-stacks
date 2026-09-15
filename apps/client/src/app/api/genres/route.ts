import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getServiceClient } from "@/lib/supabase";
import { getPersonalizedCandidateTrackSummaries } from "@/lib/fyp-personalization";
import { genreFeedCounts } from "@/lib/filtered-feed-preparation";

export const dynamic = "force-dynamic";

// GET /api/genres — eligible and ready counts for this listener's genre feeds.
export async function GET(req: NextRequest) {
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const hideLow = req.nextUrl.searchParams.get("hide_low") === "true";
    const candidates = await getPersonalizedCandidateTrackSummaries(getServiceClient(), user.id, hideLow);
    const genres = [...genreFeedCounts(candidates).entries()]
      .filter(([, count]) => count.eligible > 0)
      .sort((a, b) => b[1].eligible - a[1].eligible || a[0].localeCompare(b[0]))
      .map(([genre, count]) => ({
        genre,
        // Keep pending for older clients while making both populations explicit.
        pending: count.eligible,
        eligible: count.eligible,
        ready: count.ready,
      }));
    return NextResponse.json({ genres });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to load genres",
    }, { status: 500 });
  }
}
