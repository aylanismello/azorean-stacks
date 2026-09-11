-- Make fresh-seed 4U promotion a durable database invariant.
-- Dedicated columns avoid read/modify/write races with pipeline_status JSON.

alter table public.seeds
  add column if not exists fyp_refresh_required_at timestamptz,
  add column if not exists fyp_refreshed_at timestamptz;

create or replace function public.ensure_seed_fyp_refresh_required()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  should_mark boolean := false;
  status jsonb := coalesce(new.pipeline_status, '{}'::jsonb);
begin
  if new.user_id is null or new.active is not true then
    return new;
  end if;

  if tg_op = 'INSERT' then
    should_mark := true;
  elsif tg_op = 'UPDATE' then
    should_mark := (old.active is not true and new.active is true)
      or (old.user_id is null and new.user_id is not null);
  end if;

  if should_mark then
    if not (status ? 'state') then
      status := jsonb_set(status, '{state}', to_jsonb('queued'::text), true);
    end if;
    if not (status ? 'started_at') then
      status := jsonb_set(status, '{started_at}', to_jsonb(now()), true);
    end if;
    new.pipeline_status := status;
    new.fyp_refresh_required_at := coalesce(new.fyp_refresh_required_at, now());
    new.fyp_refreshed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists ensure_seed_fyp_refresh_required on public.seeds;
create trigger ensure_seed_fyp_refresh_required
before insert or update of active, user_id on public.seeds
for each row execute function public.ensure_seed_fyp_refresh_required();

create index if not exists idx_seeds_pending_fyp_refresh
on public.seeds (fyp_refresh_required_at)
where active = true
  and user_id is not null
  and fyp_refresh_required_at is not null
  and fyp_refreshed_at is null;
