-- Restore the original referential-cleanup exceptions while retaining the
-- two tightly scoped neutral-evidence corrections introduced for TASK-33.

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

  -- Preserve the original cascade-only cleanup exceptions.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;
  if tg_op = 'DELETE'
     and tg_table_name = 'ranking_outcomes'
     and not exists (
       select 1 from public.ranking_exposures where id = old.exposure_id
     ) then
    return old;
  end if;

  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql security definer set search_path = '';
