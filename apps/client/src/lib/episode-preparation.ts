import { acquisitionSource, boundedPreparationWindow, MixPreparationEntry } from "./mix-series";

export interface EpisodePreparationAppearance {
  position: number;
  track_id: string;
}

export interface EpisodePreparationResponse {
  session_id: string;
  current_position: number;
  ready: EpisodePreparationAppearance[];
  queued: EpisodePreparationAppearance[];
  unavailable: EpisodePreparationAppearance[];
}

export interface EpisodeSession {
  id: string;
  current_position: number;
}

export interface AcquisitionRequest {
  track_id: string;
  user_id: string;
  youtube_url: string;
  status: "pending";
}

export interface PrepareEpisodeDependencies {
  getUserId(request: Request): Promise<string | null>;
  findOwnedSession(input: { sessionId: string; episodeId: string; userId: string }): Promise<EpisodeSession | null>;
  listEpisodeEntries(episodeId: string): Promise<MixPreparationEntry[]>;
  listActiveAcquisitionTrackIds(trackIds: string[]): Promise<string[]>;
  insertAcquisitionRequests(requests: AcquisitionRequest[]): Promise<void>;
  updateOwnedSession(input: {
    sessionId: string;
    userId: string;
    lastPosition: number;
    currentPosition: number;
    updatedAt: string;
  }): Promise<void>;
  now?(): Date;
}

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function appearance(entry: MixPreparationEntry): EpisodePreparationAppearance {
  return { position: entry.position, track_id: entry.track_id! };
}

export function createPrepareEpisodeHandler(dependencies: PrepareEpisodeDependencies) {
  return async function prepareEpisode(request: Request, context: RouteContext): Promise<Response> {
    try {
      const userId = await dependencies.getUserId(request);
      if (!userId) return json({ error: "Unauthorized" }, 401);

      const { id: episodeId } = await context.params;
      const body = await request.json().catch(() => ({})) as { session_id?: unknown; current_position?: unknown };
      if (typeof body.session_id !== "string" || !body.session_id) {
        return json({ error: "session_id is required" }, 400);
      }
      const currentPosition = body.current_position === undefined ? 0 : Number(body.current_position);
      if (!Number.isInteger(currentPosition) || currentPosition < 0) {
        return json({ error: "current_position must be a non-negative integer" }, 400);
      }

      const session = await dependencies.findOwnedSession({
        sessionId: body.session_id,
        episodeId,
        userId,
      });
      if (!session) return json({ error: "Episode session not found" }, 404);

      const entries = await dependencies.listEpisodeEntries(episodeId);
      if (!entries.some((entry) => entry.position === currentPosition)) {
        return json({ error: "current_position does not exist in this episode" }, 400);
      }

      const selected = boundedPreparationWindow(entries, currentPosition, 5);
      const ready = selected.filter((entry) => Boolean(entry.tracks?.storage_path));
      const queueable = selected.filter((entry) => Boolean(acquisitionSource(entry)));
      const unavailable = selected.filter((entry) => !entry.tracks?.storage_path && !acquisitionSource(entry));

      // Appearance results stay lossless and ordered, while acquisition work is
      // canonical-track scoped so repeated appearances cannot create duplicates.
      const firstAcquisitionByTrack = new Map<string, AcquisitionRequest>();
      for (const entry of queueable) {
        if (!firstAcquisitionByTrack.has(entry.track_id!)) {
          firstAcquisitionByTrack.set(entry.track_id!, {
            track_id: entry.track_id!,
            user_id: userId,
            youtube_url: acquisitionSource(entry)!,
            status: "pending",
          });
        }
      }

      const canonicalRequests = [...firstAcquisitionByTrack.values()];
      if (canonicalRequests.length) {
        const activeTrackIds = new Set(await dependencies.listActiveAcquisitionTrackIds(
          canonicalRequests.map((requestRow) => requestRow.track_id),
        ));
        await dependencies.insertAcquisitionRequests(
          canonicalRequests.filter((requestRow) => !activeTrackIds.has(requestRow.track_id)),
        );
      }

      const updatedAt = (dependencies.now?.() ?? new Date()).toISOString();
      await dependencies.updateOwnedSession({
        sessionId: session.id,
        userId,
        lastPosition: session.current_position,
        currentPosition,
        updatedAt,
      });

      const response: EpisodePreparationResponse = {
        session_id: session.id,
        current_position: currentPosition,
        ready: ready.map(appearance),
        queued: queueable.map(appearance),
        unavailable: unavailable.map(appearance),
      };
      return json(response, canonicalRequests.length ? 202 : 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Episode preparation failed" }, 500);
    }
  };
}
