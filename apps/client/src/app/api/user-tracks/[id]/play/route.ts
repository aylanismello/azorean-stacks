import { NextRequest } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";
import { createTrackPlayHandler } from "@/lib/track-play";

export const dynamic = "force-dynamic";

export const POST = createTrackPlayHandler({
  async getUserId(request) {
    const user = await getRequestUser(request as NextRequest);
    return user?.id ?? null;
  },
  async recordChunk(args) {
    return getServiceClient().rpc("record_user_track_play_chunk", args);
  },
});
