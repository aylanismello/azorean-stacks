-- Cross-process leases for bounded audio preparation and conservative queue eviction.

-- download_requests existed in production before this migration but was not in
-- the replayable app migration history. Define it before eviction references it.
create table if not exists download_requests (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  youtube_url text not null,
  status text not null default 'pending'
    check (status in ('pending', 'downloading', 'completed', 'failed')),
  result_audio_url text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  claimed_at timestamptz
);

-- These legacy catalog flags predated migration tracking. The eviction
-- function below references them, so define them before creating the function.
alter table tracks add column if not exists is_seed boolean not null default false;
alter table tracks add column if not exists is_re_seed boolean not null default false;
alter table tracks add column if not exists is_artist_seed boolean not null default false;

create table if not exists audio_preparation_claims (
  track_id uuid primary key references tracks(id) on delete cascade,
  owner_token uuid not null,
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null
);

create index if not exists idx_audio_preparation_claims_expiry
  on audio_preparation_claims(lease_expires_at);

alter table audio_preparation_claims enable row level security;

-- A single insert/upsert statement makes claiming atomic across downloader processes.
-- Expired leases may be stolen after a crash; a live lease may only be renewed by
-- its current owner.
create or replace function claim_audio_preparation_tracks(
  p_track_ids uuid[],
  p_owner_token uuid,
  p_lease_seconds integer default 900
)
returns table(track_id uuid)
language sql
security invoker
set search_path = public
as $$
  insert into audio_preparation_claims (track_id, owner_token, claimed_at, lease_expires_at)
  select candidate.track_id,
         p_owner_token,
         now(),
         now() + make_interval(secs => greatest(30, least(p_lease_seconds, 3600)))
  from (select distinct unnest(p_track_ids) as track_id) candidate
  on conflict (track_id) do update
    set owner_token = excluded.owner_token,
        claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at
    where audio_preparation_claims.lease_expires_at <= now()
       or audio_preparation_claims.owner_token = excluded.owner_token
  returning audio_preparation_claims.track_id;
$$;

create or replace function release_audio_preparation_tracks(
  p_track_ids uuid[],
  p_owner_token uuid
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  released_count integer;
begin
  delete from audio_preparation_claims
  where track_id = any(p_track_ids)
    and owner_token = p_owner_token;
  get diagnostics released_count = row_count;
  return released_count;
end;
$$;

-- Clear references for retired predictive audio before the caller removes storage
-- objects. A path is eligible only when every track sharing it is itself retired
-- queue audio and no track has any positive, permanent, seed, request, active-warm,
-- or legacy-protected reference. If storage deletion later fails, the result is an
-- unreachable leaked object rather than a database row pointing at missing audio.
create or replace function evict_retired_queue_audio(p_warm_target integer default 20)
returns table(storage_path text)
language sql
security invoker
set search_path = public
as $$
  with protected_track_ids as materialized (
    select distinct ut.track_id
    from user_tracks ut
    where ut.status = 'approved'
       or ut.super_liked
       or ut.permanent
       or ut.local_download_intent
    union
    select distinct s.track_id
    from seeds s
    where s.track_id is not null and s.active = true
    union
    select distinct dr.track_id
    from download_requests dr
    where dr.track_id is not null and dr.status in ('pending', 'downloading')
    union
    select distinct q.track_id
    from audio_preparation_queue q
    where q.state in ('ranked', 'preparing', 'ready')
      and q.expires_at > now()
      and q.rank <= greatest(1, p_warm_target)
    union
    select t.id
    from tracks t
    where t.status = 'approved'
       or coalesce(t.is_seed, false)
       or coalesce(t.is_re_seed, false)
       or coalesce(t.is_artist_seed, false)
       or lower(coalesce(t.source, '')) in ('seed', 'manual', 'picodrops', 'pico_drops')
       or t.metadata @> '{"permanent": true}'::jsonb
       or t.metadata @> '{"keep_audio": true}'::jsonb
       or t.metadata @> '{"local_download_intent": true}'::jsonb
       or t.metadata @> '{"is_seed": true}'::jsonb
       or t.metadata @> '{"is_re_seed": true}'::jsonb
       or t.metadata @> '{"picodrop": true}'::jsonb
       or t.metadata @> '{"pico_drop": true}'::jsonb
       or t.metadata @> '{"pico_drops": true}'::jsonb
       or t.metadata @> '{"creator_supplied": true}'::jsonb
  ),
  retired_track_ids as materialized (
    select distinct q.track_id
    from audio_preparation_queue q
    where q.state = 'consumed'
      and not exists (
        select 1 from protected_track_ids protected where protected.track_id = q.track_id
      )
  ),
  candidate_paths as materialized (
    select distinct t.storage_path
    from tracks t
    join retired_track_ids retired on retired.track_id = t.id
    where t.storage_path is not null
  ),
  eligible_paths as materialized (
    select candidate.storage_path
    from candidate_paths candidate
    where not exists (
      select 1
      from tracks shared
      where shared.storage_path = candidate.storage_path
        and not exists (
          select 1 from retired_track_ids retired where retired.track_id = shared.id
        )
    )
  ),
  to_clear as materialized (
    select t.id, t.storage_path
    from tracks t
    join eligible_paths eligible on eligible.storage_path = t.storage_path
  ),
  cleared as (
    update tracks t
    set storage_path = null,
        download_url = null,
        downloaded_at = null
    from to_clear doomed
    where t.id = doomed.id
    returning doomed.storage_path
  )
  select distinct cleared.storage_path from cleared;
$$;

revoke all on audio_preparation_claims from public, anon, authenticated;
revoke all on function claim_audio_preparation_tracks(uuid[], uuid, integer) from public, anon, authenticated;
revoke all on function release_audio_preparation_tracks(uuid[], uuid) from public, anon, authenticated;
revoke all on function evict_retired_queue_audio(integer) from public, anon, authenticated;
grant all on audio_preparation_claims to service_role;
grant execute on function claim_audio_preparation_tracks(uuid[], uuid, integer) to service_role;
grant execute on function release_audio_preparation_tracks(uuid[], uuid) to service_role;
grant execute on function evict_retired_queue_audio(integer) to service_role;

comment on table audio_preparation_claims is
  'Short-lived cross-process leases preventing duplicate preparation of one track.';
