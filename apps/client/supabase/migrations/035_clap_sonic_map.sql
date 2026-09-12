-- Isolated CLAP sonic-map storage and durable embedding work queue.
-- Raw vectors and job internals are service-only; browser clients receive only
-- user-scoped neighbor IDs and similarities through the guarded RPC below.

create extension if not exists vector;

create table if not exists public.track_sonic_embeddings (
  track_id uuid primary key references public.tracks(id) on delete cascade,
  embedding vector(512) not null,
  model_id text not null,
  model_revision text not null,
  embedding_version text not null default 'clap_3x20_region_10_window_v1',
  segment_windows jsonb not null,
  sound_labels jsonb not null default '[]'::jsonb,
  audio_fingerprint text,
  cluster_id integer,
  embedded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(segment_windows) = 'array'),
  check (jsonb_array_length(segment_windows) = 3),
  check (jsonb_typeof(sound_labels) = 'array')
);

create index if not exists idx_track_sonic_embeddings_cosine
  on public.track_sonic_embeddings using hnsw (embedding vector_cosine_ops);
create index if not exists idx_track_sonic_embeddings_cluster
  on public.track_sonic_embeddings(cluster_id) where cluster_id is not null;
create index if not exists idx_track_sonic_embeddings_model
  on public.track_sonic_embeddings(model_id, model_revision, embedding_version);

create table if not exists public.sonic_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null unique references public.tracks(id) on delete cascade,
  state text not null default 'queued'
    check (state in ('queued', 'leased', 'completed', 'failed')),
  priority integer not null default 0,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_owner uuid,
  lease_token uuid,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (state = 'leased' and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_token is null and lease_expires_at is null)
  )
);

create index if not exists idx_sonic_embedding_jobs_claim
  on public.sonic_embedding_jobs(priority desc, next_attempt_at, created_at)
  where state in ('queued', 'leased');

-- Seed replayable work for existing stored audio. A changed storage object invalidates
-- prior work and increments the fence so an old worker cannot publish stale output.
insert into public.sonic_embedding_jobs (track_id)
select t.id
from public.tracks t
left join public.track_sonic_embeddings e on e.track_id = t.id
where t.storage_path is not null and e.track_id is null
on conflict (track_id) do nothing;

create or replace function public.queue_changed_track_for_sonic_embedding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.storage_path is distinct from new.storage_path then
    delete from public.track_sonic_embeddings where track_id = new.id;
    if new.storage_path is null then
      delete from public.sonic_embedding_jobs where track_id = new.id;
      return new;
    end if;
  end if;

  if new.storage_path is not null and (
    tg_op = 'INSERT' or old.storage_path is distinct from new.storage_path
  ) then
    insert into public.sonic_embedding_jobs (track_id)
    values (new.id)
    on conflict (track_id) do update set
      state = 'queued', attempts = 0, next_attempt_at = now(),
      lease_owner = null, lease_token = null, lease_expires_at = null,
      lease_generation = public.sonic_embedding_jobs.lease_generation + 1,
      completed_at = null, last_error = null, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists queue_track_sonic_embedding on public.tracks;
create trigger queue_track_sonic_embedding
after insert or update of storage_path on public.tracks
for each row execute function public.queue_changed_track_for_sonic_embedding();

alter table public.track_sonic_embeddings enable row level security;
alter table public.sonic_embedding_jobs enable row level security;
revoke all on public.track_sonic_embeddings from public, anon, authenticated;
revoke all on public.sonic_embedding_jobs from public, anon, authenticated;
grant all on public.track_sonic_embeddings to service_role;
grant all on public.sonic_embedding_jobs to service_role;

create or replace function public.enqueue_sonic_embedding_job(
  p_track_id uuid,
  p_priority integer default 0,
  p_force boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_should_queue boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tracks t where t.id = p_track_id and t.storage_path is not null
  ) then
    raise exception 'track has no stored audio' using errcode = '22023';
  end if;

  v_should_queue := p_force or not exists (
    select 1 from public.track_sonic_embeddings e where e.track_id = p_track_id
  );

  insert into public.sonic_embedding_jobs (track_id, priority)
  values (p_track_id, p_priority)
  on conflict (track_id) do update
    set priority = greatest(public.sonic_embedding_jobs.priority, excluded.priority),
        state = case when v_should_queue then 'queued' else public.sonic_embedding_jobs.state end,
        attempts = case when v_should_queue then 0 else public.sonic_embedding_jobs.attempts end,
        next_attempt_at = case when v_should_queue then now() else public.sonic_embedding_jobs.next_attempt_at end,
        lease_owner = case when v_should_queue then null else public.sonic_embedding_jobs.lease_owner end,
        lease_token = case when v_should_queue then null else public.sonic_embedding_jobs.lease_token end,
        lease_generation = case when v_should_queue then public.sonic_embedding_jobs.lease_generation + 1 else public.sonic_embedding_jobs.lease_generation end,
        lease_expires_at = case when v_should_queue then null else public.sonic_embedding_jobs.lease_expires_at end,
        completed_at = case when v_should_queue then null else public.sonic_embedding_jobs.completed_at end,
        last_error = case when v_should_queue then null else public.sonic_embedding_jobs.last_error end,
        updated_at = now()
  returning id into v_job_id;
  return v_job_id;
end;
$$;

create or replace function public.claim_sonic_embedding_jobs(
  p_owner uuid,
  p_limit integer default 1,
  p_lease_seconds integer default 900
)
returns table(
  job_id uuid,
  track_id uuid,
  storage_path text,
  lease_token uuid,
  lease_generation bigint,
  lease_expires_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select j.id
    from public.sonic_embedding_jobs j
    join public.tracks t on t.id = j.track_id and t.storage_path is not null
    where (j.state = 'queued' and j.next_attempt_at <= now())
       or (j.state = 'leased' and j.lease_expires_at <= now())
    order by j.priority desc, j.next_attempt_at, j.created_at
    for update of j skip locked
    limit greatest(1, least(p_limit, 25))
  ), claimed as (
    update public.sonic_embedding_jobs j
    set state = 'leased',
        attempts = j.attempts + 1,
        lease_owner = p_owner,
        lease_token = gen_random_uuid(),
        lease_generation = j.lease_generation + 1,
        lease_expires_at = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 3600))),
        started_at = coalesce(j.started_at, now()),
        updated_at = now()
    from candidates c
    where j.id = c.id
    returning j.*
  )
  select c.id, c.track_id, t.storage_path, c.lease_token, c.lease_generation,
         c.lease_expires_at, c.attempts
  from claimed c
  join public.tracks t on t.id = c.track_id;
end;
$$;

create or replace function public.complete_sonic_embedding_job(
  p_job_id uuid,
  p_owner uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_embedding text,
  p_model_id text,
  p_model_revision text,
  p_embedding_version text,
  p_segment_windows jsonb,
  p_sound_labels jsonb default '[]'::jsonb,
  p_audio_fingerprint text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_track_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select j.track_id into v_track_id
  from public.sonic_embedding_jobs j
  where j.id = p_job_id and j.state = 'leased'
    and j.lease_owner = p_owner and j.lease_token = p_lease_token
    and j.lease_generation = p_lease_generation
    and j.lease_expires_at > now()
  for update;
  if v_track_id is null then return false; end if;

  insert into public.track_sonic_embeddings (
    track_id, embedding, model_id, model_revision, embedding_version,
    segment_windows, sound_labels, audio_fingerprint, embedded_at, updated_at
  ) values (
    v_track_id, p_embedding::public.vector(512), p_model_id, p_model_revision,
    p_embedding_version, p_segment_windows, coalesce(p_sound_labels, '[]'::jsonb),
    p_audio_fingerprint, now(), now()
  )
  on conflict (track_id) do update set
    embedding = excluded.embedding,
    model_id = excluded.model_id,
    model_revision = excluded.model_revision,
    embedding_version = excluded.embedding_version,
    segment_windows = excluded.segment_windows,
    sound_labels = excluded.sound_labels,
    audio_fingerprint = excluded.audio_fingerprint,
    embedded_at = excluded.embedded_at,
    updated_at = excluded.updated_at;

  update public.sonic_embedding_jobs
  set state = 'completed', completed_at = now(), updated_at = now(),
      lease_owner = null, lease_token = null, lease_expires_at = null, last_error = null
  where id = p_job_id;
  return true;
end;
$$;

create or replace function public.fail_sonic_embedding_job(
  p_job_id uuid,
  p_owner uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select j.attempts, j.max_attempts into v_attempts, v_max_attempts
  from public.sonic_embedding_jobs j
  where j.id = p_job_id and j.state = 'leased'
    and j.lease_owner = p_owner and j.lease_token = p_lease_token
    and j.lease_generation = p_lease_generation
    and j.lease_expires_at > now()
  for update;
  if v_attempts is null then return false; end if;

  update public.sonic_embedding_jobs
  set state = case when v_attempts >= v_max_attempts then 'failed' else 'queued' end,
      next_attempt_at = case when v_attempts >= v_max_attempts then next_attempt_at
        else now() + make_interval(secs => least(3600, 30 * power(2, greatest(0, v_attempts - 1))::integer)) end,
      lease_owner = null, lease_token = null, lease_expires_at = null,
      last_error = left(coalesce(p_error, 'unknown sonic embedding error'), 2000), updated_at = now()
  where id = p_job_id;
  return true;
end;
$$;

create or replace function public.match_user_sonic_neighbors(
  p_user_id uuid,
  p_seed_track_ids uuid[],
  p_candidate_track_ids uuid[],
  p_limit integer default 50,
  p_max_distance double precision default 0.65
)
returns table(track_id uuid, sonic_similarity double precision)
language sql
stable
security definer
set search_path = ''
as $$
  with authorized as (
    select auth.role() = 'service_role' as allowed
  ), seed_vectors as materialized (
    select e.embedding, e.model_id, e.model_revision, e.embedding_version
    from public.track_sonic_embeddings e
    where e.track_id = any(coalesce(p_seed_track_ids, array[]::uuid[]))
      and (
        exists (select 1 from public.seeds s where s.user_id = p_user_id and s.track_id = e.track_id and s.active = true)
        or exists (select 1 from public.user_tracks ut where ut.user_id = p_user_id and ut.track_id = e.track_id)
        or exists (select 1 from public.audio_preparation_queue q where q.user_id = p_user_id and q.track_id = e.track_id)
      )
  ), scored as (
    select candidate.track_id,
           max(1 - (candidate.embedding OPERATOR(public.<=>) seed_vectors.embedding))::double precision as sonic_similarity
    from authorized
    join seed_vectors on true
    join public.track_sonic_embeddings candidate
      on candidate.model_id = seed_vectors.model_id
     and candidate.model_revision = seed_vectors.model_revision
     and candidate.embedding_version = seed_vectors.embedding_version
    where authorized.allowed
      and candidate.track_id = any(coalesce(p_candidate_track_ids, array[]::uuid[]))
      and candidate.track_id <> all(coalesce(p_seed_track_ids, array[]::uuid[]))
      and (candidate.embedding OPERATOR(public.<=>) seed_vectors.embedding) <= greatest(0, least(p_max_distance, 2))
      and exists (
        select 1 from public.user_tracks eligible
        where eligible.user_id = p_user_id
          and eligible.track_id = candidate.track_id
          and eligible.status = 'pending'
      )
      and not exists (
        select 1 from public.user_tracks acted
        where acted.user_id = p_user_id
          and acted.track_id = candidate.track_id
          and acted.status <> 'pending'
      )
      and not exists (
        select 1 from public.user_track_play_sessions played
        where played.user_id = p_user_id and played.track_id = candidate.track_id and played.listened_ms > 0
      )
      and not exists (
        select 1 from public.seeds active_seed
        where active_seed.user_id = p_user_id and active_seed.track_id = candidate.track_id and active_seed.active = true
      )
    group by candidate.track_id
  )
  select scored.track_id, scored.sonic_similarity
  from scored
  order by scored.sonic_similarity desc, scored.track_id
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function public.enqueue_sonic_embedding_job(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.claim_sonic_embedding_jobs(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_sonic_embedding_job(uuid, uuid, uuid, bigint, text, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_sonic_embedding_job(uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.match_user_sonic_neighbors(uuid, uuid[], uuid[], integer, double precision) from public, anon, authenticated;
revoke all on function public.queue_changed_track_for_sonic_embedding() from public, anon, authenticated;
grant execute on function public.enqueue_sonic_embedding_job(uuid, integer, boolean) to service_role;
grant execute on function public.claim_sonic_embedding_jobs(uuid, integer, integer) to service_role;
grant execute on function public.complete_sonic_embedding_job(uuid, uuid, uuid, bigint, text, text, text, text, jsonb, jsonb, text) to service_role;
grant execute on function public.fail_sonic_embedding_job(uuid, uuid, uuid, bigint, text) to service_role;
grant execute on function public.match_user_sonic_neighbors(uuid, uuid[], uuid[], integer, double precision) to service_role;

comment on table public.track_sonic_embeddings is
  'Service-only 512-dimensional CLAP audio embeddings; separate from semantic tracks.embedding.';
comment on table public.sonic_embedding_jobs is
  'Durable CLAP work queue with expiring leases and monotonically increasing fencing generations.';
