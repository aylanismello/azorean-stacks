import { NextRequest } from "next/server";
import {
  AcquisitionRequest,
  createPrepareEpisodeHandler,
  PrepareEpisodeDependencies,
} from "@/lib/episode-preparation";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function databaseError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

const dependencies: PrepareEpisodeDependencies = {
  async getUserId(request) {
    return (await getRequestUser(request as NextRequest))?.id ?? null;
  },
  async findOwnedSession({ sessionId, episodeId, userId }) {
    const { data, error } = await getServiceClient().from("user_episode_sessions")
      .select("id,current_position")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("episode_id", episodeId)
      .maybeSingle();
    databaseError(error);
    return data;
  },
  async listEpisodeEntries(episodeId) {
    const { data, error } = await getServiceClient().from("episode_track_entries")
      .select("position,track_id,tracks(storage_path,youtube_url,metadata)")
      .eq("episode_id", episodeId)
      .order("position", { ascending: true });
    databaseError(error);
    return (data || []).map((entry: any) => ({
      position: entry.position,
      track_id: entry.track_id,
      tracks: Array.isArray(entry.tracks) ? entry.tracks[0] || null : entry.tracks,
    }));
  },
  async listActiveAcquisitionTrackIds(trackIds) {
    const { data, error } = await getServiceClient().from("download_requests")
      .select("track_id")
      .in("track_id", trackIds)
      .in("status", ["pending", "downloading"]);
    databaseError(error);
    return (data || []).map((row: { track_id: string }) => row.track_id);
  },
  async insertAcquisitionRequests(requests: AcquisitionRequest[]) {
    if (!requests.length) return;
    const results = await Promise.all(requests.map((request) =>
      getServiceClient().from("download_requests").insert(request),
    ));
    const error = results.find((result) => result.error && result.error.code !== "23505")?.error;
    databaseError(error || null);
  },
  async updateOwnedSession({ sessionId, userId, lastPosition, currentPosition, updatedAt }) {
    const { error } = await getServiceClient().from("user_episode_sessions")
      .update({
        last_position: lastPosition,
        current_position: currentPosition,
        updated_at: updatedAt,
      })
      .eq("id", sessionId)
      .eq("user_id", userId);
    databaseError(error);
  },
};

const handler = createPrepareEpisodeHandler(dependencies);

export async function POST(request: NextRequest, context: Context) {
  return handler(request, context);
}
