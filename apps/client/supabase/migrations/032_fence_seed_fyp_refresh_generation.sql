-- Fence fresh-seed 4U recovery to one owner and one activation generation.

create or replace function public.ensure_seed_fyp_refresh_required()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  should_mark boolean := false;
  new_generation boolean := false;
  status jsonb := coalesce(new.pipeline_status, '{}'::jsonb);
begin
  if new.user_id is null or new.active is not true then
    return new;
  end if;

  if tg_op = 'INSERT' then
    should_mark := true;
  elsif tg_op = 'UPDATE' then
    new_generation := (old.active is distinct from true and new.active is true)
      or (old.user_id is distinct from new.user_id);
    should_mark := new_generation;
  end if;

  if should_mark then
    if new_generation then
      -- Reactivation or reassignment is a fresh discovery generation, not a
      -- replay of the previous completed seed state.
      status := status - 'completed_at' - 'error' - 'progress';
      status := jsonb_set(status, '{state}', to_jsonb('queued'::text), true);
      status := jsonb_set(status, '{started_at}', to_jsonb(clock_timestamp()), true);
      new.fyp_refresh_required_at := clock_timestamp();
    else
      if not (status ? 'state') then
        status := jsonb_set(status, '{state}', to_jsonb('queued'::text), true);
      end if;
      if not (status ? 'started_at') then
        status := jsonb_set(status, '{started_at}', to_jsonb(clock_timestamp()), true);
      end if;
      new.fyp_refresh_required_at := coalesce(new.fyp_refresh_required_at, clock_timestamp());
    end if;

    new.pipeline_status := status;
    new.fyp_refreshed_at := null;
    new.fyp_refresh_claimed_at := null;
  end if;

  return new;
end;
$$;
