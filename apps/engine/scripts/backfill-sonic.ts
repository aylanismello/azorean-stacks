#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

const db = getSupabase();
const force = process.argv.includes("--force");
const priorityArg = process.argv.find((argument) => argument.startsWith("--priority="));
const priority = priorityArg ? Number(priorityArg.split("=")[1]) : 0;
const pageSize = 500;
let offset = 0;
let scanned = 0;
let enqueued = 0;

while (true) {
  const { data: tracks, error } = await db
    .from("tracks")
    .select("id, track_sonic_embeddings(track_id)")
    .not("storage_path", "is", null)
    .order("id")
    .range(offset, offset + pageSize - 1);
  if (error) throw new Error(error.message);
  if (!tracks?.length) break;

  for (const track of tracks) {
    scanned += 1;
    const existing = Array.isArray(track.track_sonic_embeddings)
      ? track.track_sonic_embeddings.length > 0
      : Boolean(track.track_sonic_embeddings);
    if (existing && !force) continue;
    const { error: enqueueError } = await db.rpc("enqueue_sonic_embedding_job", {
      p_track_id: track.id,
      p_priority: Number.isFinite(priority) ? priority : 0,
      p_force: force,
    });
    if (enqueueError) throw new Error(`${track.id}: ${enqueueError.message}`);
    enqueued += 1;
  }
  offset += tracks.length;
  if (tracks.length < pageSize) break;
}

console.log(JSON.stringify({ scanned, enqueued, force, priority }));
