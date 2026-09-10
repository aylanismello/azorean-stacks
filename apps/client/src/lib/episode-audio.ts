export interface EpisodeAudioDependencies {
  getUserId(request: Request): Promise<string | null>;
  findOwnedSession(input: { sessionId: string; episodeId: string; userId: string }): Promise<{ id: string } | null>;
  findEpisodeAppearance(input: { appearanceId: string; episodeId: string }): Promise<{ storagePath: string | null } | null>;
  createSignedUrl(storagePath: string): Promise<string | null>;
}

type RouteContext = { params: Promise<{ id: string }> };

export function createEpisodeAudioHandler(dependencies: EpisodeAudioDependencies) {
  return async function episodeAudio(request: Request, context: RouteContext): Promise<Response> {
    try {
      const userId = await dependencies.getUserId(request);
      if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const { id: episodeId } = await context.params;
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("session_id");
      const appearanceId = url.searchParams.get("appearance_id");
      if (!sessionId || !appearanceId) {
        return Response.json({ error: "session_id and appearance_id are required" }, { status: 400 });
      }
      const session = await dependencies.findOwnedSession({ sessionId, episodeId, userId });
      if (!session) return Response.json({ error: "Episode session not found" }, { status: 404 });
      const appearance = await dependencies.findEpisodeAppearance({ appearanceId, episodeId });
      if (!appearance) return Response.json({ error: "Episode appearance not found" }, { status: 404 });
      if (!appearance.storagePath) return Response.json({ error: "Episode audio is not ready" }, { status: 409 });
      const signedUrl = await dependencies.createSignedUrl(appearance.storagePath);
      if (!signedUrl) return Response.json({ error: "Could not sign episode audio" }, { status: 500 });
      return Response.json({ url: signedUrl });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Episode audio refresh failed" }, { status: 500 });
    }
  };
}
