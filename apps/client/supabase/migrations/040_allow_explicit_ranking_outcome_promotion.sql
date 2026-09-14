-- Preserve append-only ranking evidence while allowing the one monotonic
-- correction needed when an explicit decision races a neutral outcome.

create or replace function public.prevent_ranking_evidence_mutation()
returns trigger as $$
begin
  if tg_op = 'UPDATE'
    and tg_table_name = 'ranking_outcomes'
    and coalesce(auth.jwt()->>'role', '') = 'service_role'
    and old.outcome in ('skipped', 'listened')
    and new.outcome in ('approved', 'rejected')
    and new.id = old.id
    and new.exposure_id = old.exposure_id
    and new.user_id = old.user_id
    and new.track_id = old.track_id
    and new.created_at = old.created_at
    and new.outcome_at >= old.outcome_at
  then
    return new;
  end if;

  -- Permit only referential cleanup initiated by deletion of the owning user or
  -- parent exposure. All other direct mutations remain forbidden.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;
  if tg_op = 'DELETE' and tg_table_name = 'ranking_outcomes' and not exists (
    select 1 from public.ranking_exposures where id = old.exposure_id
  ) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql set search_path = '';
