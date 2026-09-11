-- Durable, retry-safe per-user play sessions and aggregate listening totals.
-- Clients report cumulative listening in complete 30-second chunks. A session
-- contributes one play when it first reaches 30 seconds, and each new chunk is
-- added to the aggregate exactly once.

alter table user_tracks
  add column if not exists play_count bigint not null default 0,
  add column if not exists total_listen_duration_ms bigint not null default 0;

create table if not exists user_track_play_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  session_id uuid not null,
  listened_ms bigint not null default 0
    check (listened_ms >= 0 and listened_ms % 30000 = 0),
  qualified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, track_id, session_id)
);

create index if not exists idx_user_track_play_sessions_user_track
  on user_track_play_sessions(user_id, track_id);

alter table user_track_play_sessions enable row level security;

drop policy if exists "user_track_play_sessions_select" on user_track_play_sessions;
create policy "user_track_play_sessions_select" on user_track_play_sessions
  for select using (auth.uid() = user_id);

create or replace function record_user_track_play_chunk(
  p_user_id uuid,
  p_track_id uuid,
  p_session_id uuid,
  p_listened_ms bigint
)
returns table(
  session_listened_ms bigint,
  qualified boolean,
  play_count bigint,
  total_listen_duration_ms bigint,
  status text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_previous_listened_ms bigint;
  v_previous_qualified boolean;
  v_new_listened_ms bigint;
  v_delta_ms bigint;
  v_became_qualified boolean;
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_listened_ms < 30000 or p_listened_ms % 30000 <> 0 then
    raise exception 'listened_ms must be a positive multiple of 30000'
      using errcode = '22023';
  end if;

  -- Establish the canonical session row, then serialize all reports for it.
  -- SELECT FOR UPDATE ensures concurrent retries observe the latest committed
  -- duration before calculating their aggregate delta.
  insert into user_track_play_sessions (
    user_id, track_id, session_id, listened_ms, qualified
  ) values (
    p_user_id, p_track_id, p_session_id, 0, false
  )
  on conflict (user_id, track_id, session_id) do nothing;

  select s.listened_ms, s.qualified
    into v_previous_listened_ms, v_previous_qualified
  from user_track_play_sessions s
  where s.user_id = p_user_id
    and s.track_id = p_track_id
    and s.session_id = p_session_id
  for update;

  v_new_listened_ms := greatest(v_previous_listened_ms, p_listened_ms);
  v_delta_ms := v_new_listened_ms - v_previous_listened_ms;
  v_became_qualified := not v_previous_qualified and v_new_listened_ms >= 30000;

  update user_track_play_sessions s
  set listened_ms = v_new_listened_ms,
      qualified = v_previous_qualified or v_became_qualified,
      updated_at = now()
  where s.user_id = p_user_id
    and s.track_id = p_track_id
    and s.session_id = p_session_id;

  -- The conflict branch deliberately does not assign status: explicit votes
  -- remain authoritative. A genuine playback may create only the canonical
  -- pending relationship row when none exists yet.
  insert into user_tracks (
    user_id, track_id, status, play_count, total_listen_duration_ms
  ) values (
    p_user_id,
    p_track_id,
    'pending',
    case when v_became_qualified then 1 else 0 end,
    v_delta_ms
  )
  on conflict (user_id, track_id) do update
  set play_count = user_tracks.play_count + excluded.play_count,
      total_listen_duration_ms = user_tracks.total_listen_duration_ms
        + excluded.total_listen_duration_ms;

  return query
  select
    v_new_listened_ms,
    v_previous_qualified or v_became_qualified,
    ut.play_count,
    ut.total_listen_duration_ms,
    ut.status
  from user_tracks ut
  where ut.user_id = p_user_id and ut.track_id = p_track_id;
end;
$$;

revoke all on user_track_play_sessions from public, anon, authenticated;
revoke all on function record_user_track_play_chunk(uuid, uuid, uuid, bigint)
  from public, anon, authenticated;
grant all on user_track_play_sessions to service_role;
grant execute on function record_user_track_play_chunk(uuid, uuid, uuid, bigint)
  to service_role;

comment on column user_tracks.play_count is
  'Number of distinct playback sessions that reached 30 seconds';
comment on column user_tracks.total_listen_duration_ms is
  'Retry-safe cumulative listening time persisted in 30-second chunks';
comment on table user_track_play_sessions is
  'Per-user cumulative playback sessions used to deduplicate play and duration accounting';
