-- Let a later explicit decision replace neutral ranking evidence from a
-- racing implicit skip, without allowing neutral outcomes to overwrite an
-- explicit label for the same exposure.

create or replace function public.record_ranking_outcome(
  p_user_id uuid,
  p_track_id uuid,
  p_outcome text
)
returns boolean as $$
declare
  recorded_at timestamptz := clock_timestamp();
  selected_exposure_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' or p_user_id is null then
    raise exception 'service role required';
  end if;
  if p_outcome not in ('approved', 'rejected', 'skipped', 'listened') then
    raise exception 'invalid ranking outcome';
  end if;

  select id into selected_exposure_id
  from public.ranking_exposures
  where user_id = p_user_id
    and track_id = p_track_id
    and exposed_at < recorded_at
  order by exposed_at desc, id desc
  limit 1;

  if selected_exposure_id is null then
    return false;
  end if;

  insert into public.ranking_outcomes (exposure_id, user_id, track_id, outcome, outcome_at)
  values (selected_exposure_id, p_user_id, p_track_id, p_outcome, recorded_at)
  on conflict (exposure_id) do update
    set outcome = excluded.outcome,
        outcome_at = excluded.outcome_at
    where public.ranking_outcomes.outcome in ('skipped', 'listened')
      and excluded.outcome in ('approved', 'rejected');

  return found;
end;
$$ language plpgsql security definer set search_path = '';

revoke all on function public.record_ranking_outcome(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_ranking_outcome(uuid, uuid, text) to service_role;
