#!/usr/bin/env bun
/**
 * Conservative Supabase audio-cache cleanup.
 *
 * Discovery metadata and rows are never deleted. The dry-run manifest protects
 * likes, super-likes, active seeds/re-seeds, current FYP candidates, active
 * preparation/download requests, manual/seed sources, and recent tracks.
 * Execution is pinned to the manifest hash so the reviewed set cannot drift.
 *
 * Usage:
 *   bun run scripts/cleanup-audio-cache.ts --dry-run
 *   bun run scripts/cleanup-audio-cache.ts --execute <manifest.json> --confirm <sha256>
 */
import { parseArgs } from "util";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getSupabase } from "../lib/supabase";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    execute: { type: "string" },
    verify: { type: "string" },
    confirm: { type: "string" },
    output: { type: "string" },
    "recent-days": { type: "string", default: "14" },
    "fyp-limit": { type: "string", default: "50" },
  },
  strict: true,
});

const db = getSupabase();
const BUCKET = "tracks";
const PAGE_SIZE = 1000;
const EXECUTION_BATCH_SIZE = 200;
const MAX_RETRIES = 5;
const recentDays = Number(values["recent-days"] || 14);
const fypLimit = Number(values["fyp-limit"] || 50);

type TrackRow = {
  id: string;
  artist: string;
  title: string;
  source: string | null;
  status: string | null;
  storage_path: string | null;
  is_seed?: boolean | null;
  is_re_seed?: boolean | null;
  is_artist_seed?: boolean | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  downloaded_at?: string | null;
};

type Manifest = {
  version: 1;
  generated_at: string;
  project_url: string;
  bucket: string;
  policy: { recent_days: number; fyp_limit: number };
  totals: {
    tracks: number;
    stored_rows: number;
    distinct_paths: number;
    protected_tracks: number;
    protected_paths: number;
    deletion_rows: number;
    deletion_paths: number;
  };
  protection_counts: Record<string, number>;
  protected: Array<{ track_id: string; path: string; reasons: string[] }>;
  deletions: Array<{ track_id: string; path: string; artist: string; title: string }>;
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function manifestHash(manifest: Manifest): string {
  // JSON.stringify preserves the explicitly constructed manifest's stable order.
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function requireOk(result: any, label: string): any[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return Array.isArray(result.data) ? result.data : [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}

function isRetryable(error: unknown): boolean {
  const message = errorMessage(error);
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  return status === 408 || status === 429 || status >= 500
    || /fetch|network|timeout|timed out|connection|ECONN|socket|502|503|504|rate limit|still exists/i.test(message);
}

async function withRetry<T>(label: string, operation: () => PromiseLike<T>, attempts = MAX_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await operation() as T & { error?: unknown };
      if (!result?.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
    if (attempt === attempts || !isRetryable(lastError)) {
      throw new Error(`${label}: ${errorMessage(lastError)}`);
    }
    await Bun.sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error(`${label}: exhausted retries`);
}

async function fetchAll(table: string, select: string): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await withRetry(`${table} page ${from / PAGE_SIZE + 1}`, () =>
      db.from(table).select(select).range(from, from + PAGE_SIZE - 1));
    const page = requireOk(result, `${table} page ${from / PAGE_SIZE + 1}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function metadataProtection(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta) return [];
  const reasons: string[] = [];
  const truthyKeys = [
    "permanent", "keep_audio", "local_download_intent", "is_seed", "is_re_seed",
    "picodrop", "pico_drop", "pico_drops", "creator_supplied",
  ];
  for (const key of truthyKeys) if (meta[key] === true) reasons.push(`metadata:${key}`);
  const labels = [meta.collection, meta.destination, meta.playlist, meta.source]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (labels.some((value) => value.includes("picodrop"))) reasons.push("metadata:picodrops");
  return reasons;
}

async function buildManifest(): Promise<Manifest> {
  const [tracks, userTracks, seeds, requests] = await Promise.all([
    fetchAll("tracks", "id,artist,title,source,status,storage_path,is_seed,is_re_seed,is_artist_seed,metadata,created_at,downloaded_at"),
    fetchAll("user_tracks", "user_id,track_id,status,super_liked,permanent,local_download_intent,voted_at,created_at,downloaded_at,listen_pct"),
    fetchAll("seeds", "id,user_id,track_id,active,source"),
    fetchAll("download_requests", "track_id,status,created_at"),
  ]);

  const typedTracks = tracks as TrackRow[];
  const stored = typedTracks.filter((track) => !!track.storage_path);
  const reasonsByTrack = new Map<string, Set<string>>();
  const protect = (trackId: string | null | undefined, reason: string) => {
    if (!trackId) return;
    const reasons = reasonsByTrack.get(trackId) || new Set<string>();
    reasons.add(reason);
    reasonsByTrack.set(trackId, reasons);
  };

  // Preserve all explicit positive intent across every user. Rejected/skipped
  // outcomes stay as metadata but do not make an audio file permanent.
  for (const row of userTracks) {
    if (row.status === "approved") protect(row.track_id, "user:approved");
    if (row.super_liked) protect(row.track_id, "user:super_liked");
    if (row.permanent) protect(row.track_id, "user:permanent");
    if (row.local_download_intent) protect(row.track_id, "user:local_download_intent");
  }
  for (const seed of seeds) {
    if (seed.active) protect(seed.track_id, seed.source === "re-seed" ? "seed:active_reseed" : "seed:active");
  }
  for (const request of requests) {
    if (["pending", "downloading"].includes(request.status)) protect(request.track_id, "download_request:active");
  }

  const recentCutoff = Date.now() - recentDays * 86_400_000;
  for (const track of typedTracks) {
    if (track.status === "approved") protect(track.id, "legacy:approved");
    if (track.is_seed) protect(track.id, "track:is_seed");
    if (track.is_re_seed) protect(track.id, "track:is_re_seed");
    if (track.is_artist_seed) protect(track.id, "track:is_artist_seed");
    if (["seed", "manual", "picodrops", "pico_drops"].includes((track.source || "").toLowerCase())) {
      protect(track.id, `source:${track.source}`);
    }
    for (const reason of metadataProtection(track.metadata)) protect(track.id, reason);
    const newest = Math.max(
      track.created_at ? new Date(track.created_at).getTime() : 0,
      track.downloaded_at ? new Date(track.downloaded_at).getTime() : 0,
    );
    if (newest >= recentCutoff) protect(track.id, `recent:${recentDays}d`);
  }

  // Protect every user's currently ranked front page, even before the new
  // materialized queue migration is present.
  const userIds = Array.from(new Set([
    ...userTracks.map((row) => row.user_id),
    ...seeds.map((row) => row.user_id),
  ].filter(Boolean))).sort();
  for (const userId of userIds) {
    const result = await withRetry(`FYP protection for ${userId}`, () => db.rpc("get_fyp_tracks", {
      p_user_id: userId,
      p_limit: fypLimit,
      p_offset: 0,
      p_seed_id: null,
      p_genre: null,
      p_seed_artist: null,
      p_hide_low: false,
    }));
    if (result.error) throw new Error(`FYP protection for ${userId}: ${result.error.message}`);
    for (const row of result.data || []) protect(row.id, `fyp:${userId}`);
  }

  // If migration 020 is already applied, include the materialized queue. A
  // missing table is expected during the first rollout and is not ignored for
  // any other reason.
  let queueResult: any;
  try {
    queueResult = await withRetry("audio_preparation_queue protection", () => db.from("audio_preparation_queue")
      .select("track_id,state,expires_at")
      .in("state", ["ranked", "preparing", "ready"]));
  } catch (error) {
    queueResult = { data: null, error: { message: errorMessage(error) } };
  }
  if (!queueResult.error) {
    const now = Date.now();
    for (const row of queueResult.data || []) {
      if (!row.expires_at || new Date(row.expires_at).getTime() > now) protect(row.track_id, `queue:${row.state}`);
    }
  } else if (!/could not find the table|does not exist|schema cache/i.test(queueResult.error.message)) {
    throw new Error(`audio_preparation_queue protection: ${queueResult.error.message}`);
  }

  // A shared object survives if even one row referencing it is protected.
  const protectedPaths = new Set<string>();
  for (const track of stored) if (reasonsByTrack.has(track.id)) protectedPaths.add(track.storage_path!);

  const protectedRows = stored
    .filter((track) => protectedPaths.has(track.storage_path!))
    .map((track) => ({
      track_id: track.id,
      path: track.storage_path!,
      reasons: Array.from(reasonsByTrack.get(track.id) || ["shared_path_with_protected_track"]).sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.track_id.localeCompare(b.track_id));

  const deletions = stored
    .filter((track) => !protectedPaths.has(track.storage_path!))
    .map((track) => ({ track_id: track.id, path: track.storage_path!, artist: track.artist, title: track.title }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.track_id.localeCompare(b.track_id));

  const protectionCounts: Record<string, number> = {};
  for (const reasons of reasonsByTrack.values()) {
    for (const reason of reasons) protectionCounts[reason] = (protectionCounts[reason] || 0) + 1;
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    project_url: process.env.SUPABASE_URL || "",
    bucket: BUCKET,
    policy: { recent_days: recentDays, fyp_limit: fypLimit },
    totals: {
      tracks: typedTracks.length,
      stored_rows: stored.length,
      distinct_paths: new Set(stored.map((track) => track.storage_path!)).size,
      protected_tracks: reasonsByTrack.size,
      protected_paths: protectedPaths.size,
      deletion_rows: deletions.length,
      deletion_paths: new Set(deletions.map((row) => row.path)).size,
    },
    protection_counts: Object.fromEntries(Object.entries(protectionCounts).sort()),
    protected: protectedRows,
    deletions,
  };
}

async function verifyDeletionRows(trackIds: string[]): Promise<void> {
  for (let i = 0; i < trackIds.length; i += 200) {
    const ids = trackIds.slice(i, i + 200);
    const result = await withRetry("database deletion verification", () => db.from("tracks")
      .select("id,storage_path").in("id", ids).not("storage_path", "is", null));
    const remaining = requireOk(result, "database deletion verification");
    if (remaining.length) throw new Error(`Verification failed: ${remaining.length} track rows still reference deleted audio`);
  }
}

type PathTrackRow = Pick<TrackRow,
  "id" | "status" | "source" | "is_seed" | "is_re_seed" | "is_artist_seed" | "metadata"
> & { storage_path: string | null };

async function currentProtectionReasons(tracks: PathTrackRow[]): Promise<Map<string, Set<string>>> {
  const reasons = new Map<string, Set<string>>();
  const protect = (trackId: string | null | undefined, reason: string) => {
    if (!trackId) return;
    const trackReasons = reasons.get(trackId) || new Set<string>();
    trackReasons.add(reason);
    reasons.set(trackId, trackReasons);
  };

  for (const track of tracks) {
    if (track.status === "approved") protect(track.id, "legacy:approved");
    if (track.is_seed) protect(track.id, "track:is_seed");
    if (track.is_re_seed) protect(track.id, "track:is_re_seed");
    if (track.is_artist_seed) protect(track.id, "track:is_artist_seed");
    if (["seed", "manual", "picodrops", "pico_drops"].includes((track.source || "").toLowerCase())) {
      protect(track.id, `source:${track.source}`);
    }
    for (const reason of metadataProtection(track.metadata)) protect(track.id, reason);
  }

  const trackIds = tracks.map((track) => track.id);
  const now = new Date().toISOString();
  for (let i = 0; i < trackIds.length; i += EXECUTION_BATCH_SIZE) {
    const ids = trackIds.slice(i, i + EXECUTION_BATCH_SIZE);
    const [opinionsResult, seedsResult, queueResult, requestsResult] = await Promise.all([
      withRetry("current user retention check", () => db.from("user_tracks")
        .select("track_id,status,super_liked,permanent,local_download_intent").in("track_id", ids)),
      withRetry("current seed check", () => db.from("seeds")
        .select("track_id,source").in("track_id", ids).eq("active", true)),
      withRetry("current warm queue check", () => db.from("audio_preparation_queue")
        .select("track_id,state,expires_at").in("track_id", ids)
        .in("state", ["ranked", "preparing", "ready"]).gt("expires_at", now)),
      withRetry("current download request check", () => db.from("download_requests")
        .select("track_id,status").in("track_id", ids).in("status", ["pending", "downloading"])),
    ]);

    for (const row of requireOk(opinionsResult, "current user retention check")) {
      if (row.status === "approved") protect(row.track_id, "user:approved");
      if (row.super_liked) protect(row.track_id, "user:super_liked");
      if (row.permanent) protect(row.track_id, "user:permanent");
      if (row.local_download_intent) protect(row.track_id, "user:local_download_intent");
    }
    for (const row of requireOk(seedsResult, "current seed check")) {
      protect(row.track_id, row.source === "re-seed" ? "seed:active_reseed" : "seed:active");
    }
    for (const row of requireOk(queueResult, "current warm queue check")) protect(row.track_id, `queue:${row.state}`);
    for (const row of requireOk(requestsResult, "current download request check")) {
      protect(row.track_id, "download_request:active");
    }
  }
  return reasons;
}

async function inspectCurrentPath(path: string): Promise<PathTrackRow[]> {
  const result = await withRetry(`current references for ${path}`, () => db.from("tracks")
    .select("id,status,source,storage_path,is_seed,is_re_seed,is_artist_seed,metadata")
    .eq("storage_path", path));
  return requireOk(result, `current references for ${path}`) as PathTrackRow[];
}

async function inspectCurrentTracks(trackIds: string[]): Promise<PathTrackRow[]> {
  const tracks: PathTrackRow[] = [];
  for (let i = 0; i < trackIds.length; i += EXECUTION_BATCH_SIZE) {
    const ids = trackIds.slice(i, i + EXECUTION_BATCH_SIZE);
    const result = await withRetry("final current track check", () => db.from("tracks")
      .select("id,status,source,storage_path,is_seed,is_re_seed,is_artist_seed,metadata")
      .in("id", ids));
    tracks.push(...requireOk(result, "final current track check") as PathTrackRow[]);
  }
  return tracks;
}

async function assertPathUnprotected(path: string, tracks: PathTrackRow[]): Promise<void> {
  const reasons = await currentProtectionReasons(tracks);
  if (!reasons.size) return;
  const protectedTracks = Array.from(reasons, ([track_id, values]) => ({
    track_id,
    reasons: Array.from(values).sort(),
  })).sort((a, b) => a.track_id.localeCompare(b.track_id));
  throw new Error(`Protection drift detected; aborting before ${path}: ${JSON.stringify(protectedTracks)}`);
}

async function clearPathReferences(path: string): Promise<string[]> {
  const clearedIds = new Set<string>();
  for (let pass = 1; pass <= MAX_RETRIES; pass++) {
    const tracks = await inspectCurrentPath(path);
    if (!tracks.length) return Array.from(clearedIds);

    // This path may have gained additional references since manifest creation.
    // Re-check every current sharer immediately before the first mutation.
    await assertPathUnprotected(path, tracks);
    const clearResult = await withRetry(`clear references for ${path}`, () => db.from("tracks")
      .update({ storage_path: null, download_url: null, downloaded_at: null })
      .eq("storage_path", path)
      .select("id"));
    for (const row of requireOk(clearResult, `clear references for ${path}`)) clearedIds.add(row.id);
  }

  const remaining = await inspectCurrentPath(path);
  if (remaining.length) {
    await assertPathUnprotected(path, remaining);
    throw new Error(`Reference clear did not stabilize for ${path}; ${remaining.length} rows still reference it`);
  }
  return Array.from(clearedIds);
}

async function restorePathReferences(path: string, trackIds: string[]): Promise<void> {
  if (!trackIds.length) return;
  for (let i = 0; i < trackIds.length; i += EXECUTION_BATCH_SIZE) {
    const ids = trackIds.slice(i, i + EXECUTION_BATCH_SIZE);
    const result = await withRetry(`restore references for ${path}`, () => db.from("tracks")
      .update({ storage_path: path })
      .in("id", ids)
      .is("storage_path", null)
      .select("id"));
    const restored = requireOk(result, `restore references for ${path}`);
    if (restored.length !== ids.length) {
      throw new Error(`Could not restore every reference for ${path}: expected ${ids.length}, restored ${restored.length}`);
    }
  }
}

async function deleteStoragePath(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let removeError: unknown;
    try {
      const removeResult = await db.storage.from(BUCKET).remove([path]);
      if (removeResult.error) removeError = removeResult.error;
    } catch (error) {
      removeError = error;
    }

    // A timed-out remove may still have committed. Probe independently so an
    // absent object is treated as success and an extant one is retried.
    try {
      const probe = await probeStoragePath(path);
      if (!probe.exists) return;
      lastError = removeError || new Error("storage object still exists after deletion");
    } catch (probeError) {
      lastError = probeError;
    }

    if (attempt < MAX_RETRIES && isRetryable(lastError)) {
      await Bun.sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }

  console.error(JSON.stringify({
    error: "storage_deletion_failed_after_references_cleared",
    orphaned_objects: [path],
    detail: errorMessage(lastError),
  }, null, 2));
  throw new Error(`Storage deletion failed for ${path}; database references remain cleared`);
}

async function probeStoragePath(path: string): Promise<{ exists: boolean; bytes: number }> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Missing Supabase environment");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${base}/storage/v1/object/authenticated/${BUCKET}/${encodedPath}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: "bytes=0-0" },
    });
    if (response.status === 404) return { exists: false, bytes: 0 };
    if (response.status === 400) {
      const body = await response.text();
      if (/not found|does not exist/i.test(body)) return { exists: false, bytes: 0 };
      throw new Error(`Storage probe ${response.status} for ${path}: ${body.slice(0, 200)}`);
    }
    if (response.ok) {
      const contentRange = response.headers.get("content-range") || "";
      const totalMatch = contentRange.match(/\/(\d+)$/);
      const bytes = totalMatch ? Number(totalMatch[1]) : Number(response.headers.get("content-length") || 0);
      await response.body?.cancel();
      return { exists: true, bytes };
    }

    await response.body?.cancel();
    if (attempt === 5 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`Storage probe ${response.status} for ${path}`);
    }
    await Bun.sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error(`Storage probe exhausted retries for ${path}`);
}

async function verifyManifest(path: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  await verifyDeletionRows(manifest.deletions.map((row) => row.track_id));

  const removedPaths = Array.from(new Set(manifest.deletions.map((row) => row.path)));
  const retainedPaths = Array.from(new Set(manifest.protected.map((row) => row.path)));
  let removedStillPresent = 0;
  let retainedMissing = 0;
  let retainedBytes = 0;
  const probes = [
    ...removedPaths.map((storagePath) => ({ storagePath, expect: false })),
    ...retainedPaths.map((storagePath) => ({ storagePath, expect: true })),
  ];
  for (let i = 0; i < probes.length; i += 64) {
    const results = await Promise.all(probes.slice(i, i + 64).map(async (probe) => ({
      ...probe,
      result: await probeStoragePath(probe.storagePath),
    })));
    for (const probe of results) {
      if (!probe.expect && probe.result.exists) removedStillPresent++;
      if (probe.expect && !probe.result.exists) retainedMissing++;
      if (probe.expect && probe.result.exists) retainedBytes += probe.result.bytes;
    }
  }
  if (removedStillPresent || retainedMissing) {
    throw new Error(`Storage verification failed: ${removedStillPresent} removed paths present, ${retainedMissing} retained paths missing`);
  }
  console.log(JSON.stringify({
    verified: true,
    removed_paths_absent: removedPaths.length,
    retained_paths_present: retainedPaths.length,
    retained_bytes: retainedBytes,
  }, null, 2));
}

async function executeManifest(path: string, confirmation: string): Promise<void> {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as Manifest;
  const actualHash = manifestHash(manifest);
  if (confirmation !== actualHash) throw new Error(`Manifest hash mismatch. Expected --confirm ${actualHash}`);
  if (manifest.version !== 1 || manifest.bucket !== BUCKET) throw new Error("Unsupported cleanup manifest");
  if (manifest.project_url !== (process.env.SUPABASE_URL || "")) throw new Error("Manifest targets a different Supabase project");

  const pathToIds = new Map<string, string[]>();
  for (const row of manifest.deletions) {
    const ids = pathToIds.get(row.path) || [];
    ids.push(row.track_id);
    pathToIds.set(row.path, ids);
  }
  const manifestProtectedPaths = new Set(manifest.protected.map((row) => row.path));
  const overlap = Array.from(pathToIds.keys()).filter((item) => manifestProtectedPaths.has(item));
  if (overlap.length) throw new Error(`Manifest attempts to delete ${overlap.length} protected paths`);
  const paths = Array.from(pathToIds.keys());
  let deletedPaths = 0;
  let clearedRows = 0;

  for (const storagePath of paths) {
    const cleared = await clearPathReferences(storagePath);
    clearedRows += cleared.length;

    // Close the protection-check/update window as tightly as this manual tool
    // can without a database RPC. If intent changes after references were
    // cleared but before object deletion, restore the path and abort safely.
    try {
      const finalTracks = await inspectCurrentTracks(cleared);
      await assertPathUnprotected(storagePath, finalTracks);
      const lateSharers = await inspectCurrentPath(storagePath);
      if (lateSharers.length) {
        await assertPathUnprotected(storagePath, lateSharers);
        throw new Error(`Shared-path drift detected before storage deletion for ${storagePath}`);
      }
    } catch (error) {
      await restorePathReferences(storagePath, cleared);
      throw error;
    }

    // Storage is mutated only after every current shared database reference is
    // gone. A failed remove leaves a recoverable orphan, never a dangling URL.
    await deleteStoragePath(storagePath);
    deletedPaths++;
    console.log(`deleted ${deletedPaths}/${paths.length} paths; cleared ${clearedRows}/${manifest.deletions.length} rows`);
  }

  await verifyDeletionRows(manifest.deletions.map((row) => row.track_id));
  console.log(JSON.stringify({ verified: true, deleted_paths: deletedPaths, cleared_rows: clearedRows }, null, 2));
}

async function main() {
  if (values.verify) {
    await verifyManifest(resolve(values.verify));
    return;
  }
  if (values.execute) {
    if (!values.confirm) throw new Error("--execute requires --confirm <manifest sha256>");
    await executeManifest(resolve(values.execute), values.confirm);
    return;
  }
  if (!values["dry-run"]) throw new Error("Choose --dry-run, --execute <manifest>, or --verify <manifest>");
  if (!Number.isFinite(recentDays) || recentDays < 1) throw new Error("--recent-days must be positive");
  if (!Number.isFinite(fypLimit) || fypLimit < 1) throw new Error("--fyp-limit must be positive");

  const manifest = await buildManifest();
  const output = resolve(values.output || `cleanup-manifests/audio-cache-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ manifest: output, sha256: manifestHash(manifest), ...manifest.totals, protection_counts: manifest.protection_counts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
