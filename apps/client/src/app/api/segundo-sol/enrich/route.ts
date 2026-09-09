import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { enrichMusicUrl } from "@/lib/segundo-sol";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "A music URL is required" }, { status: 400 });
  }

  const enriched = await enrichMusicUrl(body.url);
  if (!enriched) {
    return NextResponse.json(
      { error: "Use a Spotify, SoundCloud, Bandcamp, YouTube, or Mixcloud URL" },
      { status: 400 }
    );
  }
  return NextResponse.json({ link: enriched });
}
