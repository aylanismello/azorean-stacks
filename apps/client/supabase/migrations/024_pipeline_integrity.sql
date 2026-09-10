-- Reconcile application enums, lock global catalog writes to the engine, and
-- make download requests durable and attributable.

alter table user_tracks drop constraint if exists user_tracks_status_check;
alter table user_tracks add constraint user_tracks_status_check
  check (status in ('pending', 'approved', 'rejected', 'skipped', 'listened', 'bad_source'));

alter table seeds drop constraint if exists seeds_source_check;
alter table seeds add constraint seeds_source_check
  check (source is null or source in ('manual', 're-seed', 'auto:approved'));

-- Shared catalog/source rows are read-only to browser clients. Server routes and
-- the local engine use the service role, which bypasses RLS.
drop policy if exists "tracks_insert" on tracks;
drop policy if exists "tracks_update" on tracks;
drop policy if exists "episodes_insert" on episodes;
drop policy if exists "episodes_update" on episodes;
drop policy if exists "episode_seeds_insert" on episode_seeds;
drop policy if exists "allow all" on episode_tracks;
drop policy if exists "episode_tracks_select" on episode_tracks;
create policy "episode_tracks_select" on episode_tracks
  for select using (true);

drop policy if exists "curators_insert" on curators;
drop policy if exists "curators_update" on curators;
create table if not exists commands (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb
);
create index if not exists idx_commands_pending on commands(status) where status = 'pending';
alter table commands enable row level security;
drop policy if exists "allow all" on commands;

alter table download_requests add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table download_requests add column if not exists completed_at timestamptz;
alter table download_requests add column if not exists result_audio_url text;
alter table download_requests add column if not exists error text;
alter table download_requests add column if not exists claimed_at timestamptz;
alter table download_requests enable row level security;

update download_requests
set claimed_at = coalesce(claimed_at, created_at)
where status = 'downloading';

-- Preserve duplicate request history while leaving exactly one active worker
-- claim per canonical track.
with active_duplicates as (
  select id,
         row_number() over (partition by track_id order by created_at, id) as position
  from download_requests
  where status in ('pending', 'downloading')
)
update download_requests as request
set status = 'failed',
    completed_at = now(),
    error = coalesce(request.error || '; ', '') || 'Superseded by an earlier active request'
from active_duplicates
where request.id = active_duplicates.id
  and active_duplicates.position > 1;

create unique index if not exists idx_download_requests_one_active_track
  on download_requests(track_id)
  where status in ('pending', 'downloading');
create index if not exists idx_download_requests_status_created
  on download_requests(status, created_at);
create index if not exists idx_download_requests_status_claimed
  on download_requests(status, claimed_at);
create index if not exists idx_download_requests_user_created
  on download_requests(user_id, created_at desc);

-- Serialize corrected-source requests per track. The newest correction retires
-- the previous active request without deleting request history.
create or replace function enqueue_corrected_download_request(
  p_track_id uuid,
  p_user_id uuid,
  p_source_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  request_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_track_id::text, 0));

  if not exists (select 1 from tracks where id = p_track_id) then
    raise exception 'track not found: %', p_track_id;
  end if;

  update download_requests
  set status = 'failed',
      claimed_at = null,
      completed_at = now(),
      error = 'Superseded by a corrected source'
  where track_id = p_track_id
    and status in ('pending', 'downloading');

  insert into download_requests (track_id, user_id, youtube_url, status)
  values (p_track_id, p_user_id, p_source_url, 'pending')
  returning id into request_id;

  return request_id;
end;
$$;

revoke all on function enqueue_corrected_download_request(uuid, uuid, text) from public;
grant execute on function enqueue_corrected_download_request(uuid, uuid, text) to service_role;

-- Fence the storage pointer commit with the request row. A superseded worker
-- cannot publish stale audio after a corrected-source request takes its place.
create or replace function complete_download_request(
  p_request_id uuid,
  p_storage_path text,
  p_download_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  request_track_id uuid;
  request_status text;
begin
  select track_id, status
  into request_track_id, request_status
  from download_requests
  where id = p_request_id
  for update;

  if not found or request_status <> 'downloading' then
    return false;
  end if;

  update tracks
  set storage_path = p_storage_path,
      download_url = coalesce(p_download_url, ''),
      downloaded_at = now(),
      dl_attempts = 0,
      dl_failed_at = null
  where id = request_track_id;

  if not found then
    raise exception 'track not found for download request %', p_request_id;
  end if;

  update download_requests
  set status = 'completed',
      claimed_at = null,
      result_audio_url = p_download_url,
      completed_at = now(),
      error = null
  where id = p_request_id;

  return true;
end;
$$;

revoke all on function complete_download_request(uuid, text, text) from public;
grant execute on function complete_download_request(uuid, text, text) to service_role;


drop function if exists episode_track_stats(uuid);
create function episode_track_stats(p_user_id uuid)
returns table(episode_id uuid, total bigint, pending bigint, approved bigint, rejected bigint)
language sql
stable
set search_path = public
as $$
  select
    et.episode_id,
    count(*) as total,
    count(*) filter (where ut.status = 'pending') as pending,
    count(*) filter (where ut.status = 'approved') as approved,
    count(*) filter (where ut.status = 'rejected') as rejected
  from episode_tracks et
  join user_tracks ut
    on ut.track_id = et.track_id
   and ut.user_id = p_user_id
  group by et.episode_id
$$;

create or replace function delete_owned_seed(p_seed_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (select 1 from seeds where id = p_seed_id and user_id = p_user_id) then
    return false;
  end if;

  -- Ownership was checked above; delete legacy NULL-attributed runs too so their
  -- non-cascading seed FK cannot strand an owned seed.
  delete from discovery_runs where seed_id = p_seed_id;
  delete from episode_seeds where seed_id = p_seed_id;
  delete from seeds where id = p_seed_id and user_id = p_user_id;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

revoke all on function delete_owned_seed(uuid, uuid) from public;
grant execute on function delete_owned_seed(uuid, uuid) to authenticated, service_role;
