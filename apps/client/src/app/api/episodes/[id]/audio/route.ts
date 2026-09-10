import { NextRequest } from "next/server";
import { createEpisodeAudioHandler, type EpisodeAudioDependencies } from "@/lib/episode-audio";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

function databaseError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

const dependencies: EpisodeAudioDependencies = {
  async getUserId(request) {
    return (await getRequestUser(request as NextRequest))?.id ?? null;
  },
  async findOwnedSession({ sessionId, episodeId, userId }) {
    const { data, error } = await getServiceClient().from("user_episode_sessions")
      .select("id").eq("id", sessionId).eq("episode_id", episodeId).eq("user_id", userId).maybeSingle();
    databaseError(error);
    return data;
  },
  async findEpisodeAppearance({ appearanceId, episodeId }) {
    const { data, error } = await getServiceClient().from("episode_track_entries")
      .select("tracks(storage_path)").eq("id", appearanceId).eq("episode_id", episodeId).maybeSingle();
    databaseError(error);
    const track = Array.isArray(data?.tracks) ? data.tracks[0] : data?.tracks;
    return data ? { storagePath: track?.storage_path ?? null } : null;
  },
  async createSignedUrl(storagePath) {
    const { data, error } = await getServiceClient().storage.from("tracks").createSignedUrl(storagePath, 3600);
    databaseError(error);
    return data?.signedUrl ?? null;
  },
};

const handler = createEpisodeAudioHandler(dependencies);
export async function GET(request: NextRequest, context: Context) {
  return handler(request, context);
}
