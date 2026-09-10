export interface MixEpisodeSessionRecord {
  id: string;
  episode_id: string;
  series_id: string;
  last_position: number;
  current_position: number;
  state: "active" | "completed";
  started_at: string;
  updated_at: string;
}

export interface EpisodeSessionDependencies {
  getUserId(request: Request): Promise<string | null>;
  findEpisode(episodeId: string): Promise<{ id: string; series_id: string | null; title: string } | null>;
  episodePositionExists(input: { episodeId: string; position: number }): Promise<boolean>;
  findOwnedEpisodeSession(input: { episodeId: string; userId: string }): Promise<{ current_position: number } | null>;
  upsertOwnedEpisodeSession(input: {
    userId: string;
    seriesId: string;
    episodeId: string;
    lastPosition: number;
    currentPosition: number;
    updatedAt: string;
  }): Promise<MixEpisodeSessionRecord>;
  now?(): Date;
}

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export function createEpisodeSessionPostHandler(dependencies: EpisodeSessionDependencies) {
  return async function createSession(request: Request, context: RouteContext): Promise<Response> {
    try {
      const userId = await dependencies.getUserId(request);
      if (!userId) return json({ error: "Unauthorized" }, 401);

      const { id: episodeId } = await context.params;
      const episode = await dependencies.findEpisode(episodeId);
      if (!episode?.series_id) return json({ error: "Mix episode not found" }, 404);

      const body = await request.json().catch(() => ({})) as { current_position?: unknown };
      const currentPosition = body.current_position === undefined ? 0 : Number(body.current_position);
      if (!Number.isInteger(currentPosition) || currentPosition < 0) {
        return json({ error: "current_position must be a non-negative integer" }, 400);
      }
      if (!await dependencies.episodePositionExists({ episodeId, position: currentPosition })) {
        return json({ error: "current_position does not exist in this episode" }, 400);
      }

      const existing = await dependencies.findOwnedEpisodeSession({ episodeId, userId });
      const data = await dependencies.upsertOwnedEpisodeSession({
        userId,
        seriesId: episode.series_id,
        episodeId,
        lastPosition: existing?.current_position ?? currentPosition,
        currentPosition,
        updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      });
      return json({ session: data }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Session was not created" }, 500);
    }
  };
}
