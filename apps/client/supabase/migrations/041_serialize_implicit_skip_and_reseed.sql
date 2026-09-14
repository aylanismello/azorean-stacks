-- Serialize manual implicit skips with re-seed creation for the same
-- user/track so the final state cannot contain both an active seed and a
-- neutral skipped status.

create or replace function public.record_implicit_skip(
  p_user_id uuid,
  p_track_id uuid
)
returns table(status text, voted_at timestamptz, applied boolean) as $$
declare
  was_applied boolean := false;
  affected_rows integer := 0;
  outcome_recorded boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service role required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_track_id::text, 0));

  if exists (
    select 1
    from public.seeds
    where user_id = p_user_id
      and track_id = p_track_id
  ) then
    select ut.status, ut.voted_at
      into status, voted_at
    from public.user_tracks ut
    where ut.user_id = p_user_id
      and ut.track_id = p_track_id;
    status := coalesce(status, 'pending');
    applied := false;
    return next;
    return;
  end if;

  insert into public.user_tracks (user_id, track_id, status, voted_at)
  values (p_user_id, p_track_id, 'skipped', now())
  on conflict (user_id, track_id) do update
    set status = 'skipped',
        voted_at = excluded.voted_at
    where public.user_tracks.status = 'pending';

  get diagnostics affected_rows = row_count;
  was_applied := affected_rows > 0;

  if was_applied then
    select public.record_ranking_outcome(p_user_id, p_track_id, 'skipped')
      into outcome_recorded;
  end if;

  select ut.status, ut.voted_at
    into status, voted_at
  from public.user_tracks ut
  where ut.user_id = p_user_id
    and ut.track_id = p_track_id;

  status := coalesce(status, 'pending');
  applied := was_applied and status = 'skipped';
  return next;
end;
$$ language plpgsql security definer set search_path = '';

revoke all on function public.record_implicit_skip(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_implicit_skip(uuid, uuid) to service_role;

create or replace function public.create_reseed(
  p_user_id uuid,
  p_track_id uuid,
  p_artist text,
  p_title text,
  p_now timestamptz
)
returns uuid as $$
declare
  new_seed_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service role required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_track_id::text, 0));

  select id into new_seed_id
  from public.seeds
  where user_id = p_user_id
    and track_id = p_track_id
  limit 1;
  if new_seed_id is not null then
    return new_seed_id;
  end if;

  insert into public.seeds (
    artist,
    title,
    track_id,
    user_id,
    source,
    fyp_refresh_required_at,
    pipeline_status
  ) values (
    p_artist,
    p_title,
    p_track_id,
    p_user_id,
    're-seed',
    p_now,
    jsonb_build_object(
      'state', 'queued',
      'started_at', p_now,
      'log', jsonb_build_array(jsonb_build_object(
        't', to_char(p_now at time zone 'UTC', 'HH24:MI:SS'),
        'msg', 're-seed queued for discovery'
      ))
    )
  ) returning id into new_seed_id;

  -- A seed is stronger than a neutral skip. If the skip won the lock first,
  -- restore pending before returning so the states never coexist.
  update public.user_tracks
  set status = 'pending',
      voted_at = p_now
  where user_id = p_user_id
    and track_id = p_track_id
    and status = 'skipped';

  return new_seed_id;
end;
$$ language plpgsql security definer set search_path = '';

revoke all on function public.create_reseed(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_reseed(uuid, uuid, text, text, timestamptz) to service_role;
