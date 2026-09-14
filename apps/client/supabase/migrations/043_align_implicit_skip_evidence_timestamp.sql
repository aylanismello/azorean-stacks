-- Align a newly applied implicit skip's user-track timestamp with its ranking
-- outcome so a racing re-seed can retract that exact neutral label safely.

create or replace function public.record_implicit_skip(
  p_user_id uuid,
  p_track_id uuid
)
returns table(status text, voted_at timestamptz, applied boolean) as $$
declare
  was_applied boolean := false;
  affected_rows integer := 0;
  outcome_recorded boolean := false;
  recorded_outcome_at timestamptz;
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
    if outcome_recorded then
      select ro.outcome_at into recorded_outcome_at
      from public.ranking_outcomes ro
      where ro.user_id = p_user_id
        and ro.track_id = p_track_id
        and ro.outcome = 'skipped'
      order by ro.outcome_at desc, ro.id desc
      limit 1;
      update public.user_tracks
      set voted_at = recorded_outcome_at
      where user_id = p_user_id
        and track_id = p_track_id
        and status = 'skipped';
    end if;
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
