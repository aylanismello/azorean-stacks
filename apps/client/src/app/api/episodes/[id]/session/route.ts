import { NextRequest, NextResponse } from "next/server";
import {
  createEpisodeSessionPostHandler,
  EpisodeSessionDependencies,
} from "@/lib/episode-session";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function databaseError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

async function episodeContext(req: NextRequest, props: Context) {
  const user = await getRequestUser(req);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { id: episodeId } = await props.params;
  const db = getServiceClient();
  const { data: episode, error } = await db.from("episodes")
    .select("id,series_id,title").eq("id", episodeId).maybeSingle();
  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!episode?.series_id) return { response: NextResponse.json({ error: "Mix episode not found" }, { status: 404 }) };
  return { user, db, episode };
}

export async function GET(req: NextRequest, props: Context) {
  const context = await episodeContext(req, props);
  if ("response" in context) return context.response;
  const { data, error } = await context.db.from("user_episode_sessions")
    .select("id,episode_id,series_id,last_position,current_position,state,started_at,updated_at")
    .eq("user_id", context.user.id).eq("episode_id", context.episode.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session: data || null });
}

const dependencies: EpisodeSessionDependencies = {
  async getUserId(request) {
    return (await getRequestUser(request as NextRequest))?.id ?? null;
  },
  async findEpisode(episodeId) {
    const { data, error } = await getServiceClient().from("episodes")
      .select("id,series_id,title")
      .eq("id", episodeId)
      .maybeSingle();
    databaseError(error);
    return data;
  },
  async episodePositionExists({ episodeId, position }) {
    const { data, error } = await getServiceClient().from("episode_track_entries")
      .select("id")
      .eq("episode_id", episodeId)
      .eq("position", position)
      .maybeSingle();
    databaseError(error);
    return Boolean(data);
  },
  async findOwnedEpisodeSession({ episodeId, userId }) {
    const { data, error } = await getServiceClient().from("user_episode_sessions")
      .select("current_position")
      .eq("user_id", userId)
      .eq("episode_id", episodeId)
      .maybeSingle();
    databaseError(error);
    return data;
  },
  async upsertOwnedEpisodeSession({ userId, seriesId, episodeId, lastPosition, currentPosition, updatedAt }) {
    const { data, error } = await getServiceClient().from("user_episode_sessions").upsert({
      user_id: userId,
      series_id: seriesId,
      episode_id: episodeId,
      last_position: lastPosition,
      current_position: currentPosition,
      state: "active",
      updated_at: updatedAt,
    }, { onConflict: "user_id,episode_id" })
      .select("id,episode_id,series_id,last_position,current_position,state,started_at,updated_at")
      .single();
    databaseError(error);
    if (!data) throw new Error("Session was not created");
    return data;
  },
};

const postHandler = createEpisodeSessionPostHandler(dependencies);

export async function POST(request: NextRequest, context: Context) {
  return postHandler(request, context);
}
