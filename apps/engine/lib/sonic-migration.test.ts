import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(import.meta.dir, "../../client/supabase/migrations/035_clap_sonic_map.sql"),
  "utf8",
).toLowerCase();

describe("CLAP sonic-map migration contract", () => {
  test("keeps 512-dimensional sonic vectors separate and browser-inaccessible", () => {
    expect(migration).toContain("create table if not exists public.track_sonic_embeddings");
    expect(migration).toContain("embedding vector(512) not null");
    expect(migration).toContain("alter table public.track_sonic_embeddings enable row level security");
    expect(migration).toContain("revoke all on public.track_sonic_embeddings from public, anon, authenticated");
  });

  test("uses leases and monotonically increasing fencing generations", () => {
    expect(migration).toContain("lease_generation bigint not null default 0");
    expect(migration).toContain("lease_generation = j.lease_generation + 1");
    expect(migration).toContain("for update of j skip locked");
    expect(migration).toContain("and j.lease_expires_at > now()");
    expect(migration).toContain("delete from public.track_sonic_embeddings where track_id = new.id");
    expect(migration).toContain("v_should_queue := p_force or not exists");
  });

  test("exposes service-only lifecycle RPCs and user-scoped eligible matching", () => {
    for (const rpc of ["claim_sonic_embedding_jobs", "complete_sonic_embedding_job", "fail_sonic_embedding_job"]) {
      expect(migration).toContain(`grant execute on function public.${rpc}`);
      expect(migration).toContain(`function public.${rpc}`);
    }
    expect(migration).toContain("select auth.role() = 'service_role' as allowed");
    expect(migration).toContain("candidate.track_id = any(coalesce(p_candidate_track_ids");
    expect(migration).toContain("from public.user_tracks eligible");
    expect(migration).toContain("eligible.status = 'pending'");
    expect(migration).toContain("from public.user_tracks acted");
    expect(migration).toContain("from public.user_track_play_sessions played");
    expect(migration).toContain("from public.seeds active_seed");
    expect(migration).toContain("candidate.model_revision = seed_vectors.model_revision");
    expect(migration).toContain("candidate.embedding_version = seed_vectors.embedding_version");
    expect(migration).toContain("p_embedding::public.vector(512)");
    expect(migration).toContain("candidate.embedding operator(public.<=>) seed_vectors.embedding");
    expect(migration).toContain("to service_role");
  });
});
