-- If a re-seed wins after an implicit skip, retract only the neutral outcome
-- created by that exact transaction timestamp. Historical evidence remains
-- immutable.

create or replace function public.prevent_ranking_evidence_mutation()
returns trigger as $$
begin
  if tg_op = 'UPDATE'
     and tg_table_name = 'ranking_outcomes'
     and coalesce(auth.jwt()->>'role', '') = 'service_role'
     and old.id = new.id
     and old.exposure_id = new.exposure_id
     and old.user_id = new.user_id
     and old.track_id = new.track_id
     and old.created_at = new.created_at
     and old.outcome in ('skipped', 'listened')
     and new.outcome in ('approved', 'rejected')
     and new.outcome_at >= old.outcome_at then
    return new;
  end if;

  if tg_op = 'DELETE'
     and tg_table_name = 'ranking_outcomes'
     and coalesce(auth.jwt()->>'role', '') = 'service_role'
     and old.outcome = 'skipped'
     and exists (
       select 1 from public.seeds s
       where s.user_id = old.user_id and s.track_id = old.track_id
     )
     and exists (
       select 1 from public.user_tracks ut
       where ut.user_id = old.user_id
         and ut.track_id = old.track_id
         and ut.status = 'skipped'
         and ut.voted_at = old.outcome_at
     ) then
    return old;
  end if;

  if tg_op = 'DELETE'
     and tg_table_name = 'ranking_exposures'
     and coalesce(auth.jwt()->>'role', '') = 'service_role'
     and exists (
       select 1 from public.ranking_exposure_cleanup_log
       where id = 1
         and cleanup_started_at >= statement_timestamp() - interval '5 minutes'
     ) then
    return old;
  end if;

  raise exception '% on % is forbidden: ranking evidence is append-only', tg_op, tg_table_name;
end;
$$ language plpgsql security definer set search_path = '';

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

  if new_seed_id is null then
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
  end if;

  -- now() is transaction-stable, so this removes only the outcome recorded by
  -- the exact implicit skip being superseded, not an older explicit skip.
  delete from public.ranking_outcomes ro
  using public.user_tracks ut
  where ro.user_id = p_user_id
    and ro.track_id = p_track_id
    and ro.outcome = 'skipped'
    and ut.user_id = p_user_id
    and ut.track_id = p_track_id
    and ut.status = 'skipped'
    and ro.outcome_at = ut.voted_at;

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
