#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

const db = getSupabase();
const states = ["queued", "leased", "completed", "failed"] as const;
const counts: Record<string, number> = {};

for (const state of states) {
  const { count, error } = await db
    .from("sonic_embedding_jobs")
    .select("id", { count: "exact", head: true })
    .eq("state", state);
  if (error) throw new Error(error.message);
  counts[state] = count || 0;
}

const [{ count: embeddings, error: embeddingError }, { count: expiredLeases, error: leaseError }] = await Promise.all([
  db.from("track_sonic_embeddings").select("track_id", { count: "exact", head: true }),
  db.from("sonic_embedding_jobs")
    .select("id", { count: "exact", head: true })
    .eq("state", "leased")
    .lte("lease_expires_at", new Date().toISOString()),
]);
if (embeddingError) throw new Error(embeddingError.message);
if (leaseError) throw new Error(leaseError.message);

console.log(JSON.stringify({ embeddings: embeddings || 0, jobs: counts, expired_leases: expiredLeases || 0 }, null, 2));
