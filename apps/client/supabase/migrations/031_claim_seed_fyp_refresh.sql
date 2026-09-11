-- Serialize durable seed-to-4U recovery across worker processes.

alter table public.seeds
  add column if not exists fyp_refresh_claimed_at timestamptz;

-- Enroll only the latest completed active seed for each user. Older seeds already
-- contributed to aggregate scoring; the bounded fresh lane represents the latest seed.
with latest_completed as (
  select
    id,
    row_number() over (partition by user_id order by created_at desc, id desc) as ordinal
  from public.seeds
  where active = true
    and user_id is not null
    and pipeline_status->>'state' = 'done'
)
update public.seeds as seed
set
  fyp_refresh_required_at = coalesce(seed.fyp_refresh_required_at, seed.created_at, now()),
  fyp_refreshed_at = null,
  fyp_refresh_claimed_at = null
from latest_completed
where seed.id = latest_completed.id
  and latest_completed.ordinal = 1
  and seed.fyp_refresh_required_at is null;

create or replace function public.claim_seed_fyp_refresh(
  p_seed_id uuid,
  p_required_at timestamptz
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_id uuid;
  claim_token timestamptz;
begin
  select user_id
  into owner_id
  from public.seeds
  where id = p_seed_id
    and active = true
    and user_id is not null
    and fyp_refresh_required_at = p_required_at
    and fyp_refreshed_at is null;

  if owner_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));

  update public.seeds as seed
  set fyp_refresh_claimed_at = clock_timestamp()
  where seed.id = p_seed_id
    and seed.user_id = owner_id
    and seed.active = true
    and seed.fyp_refresh_required_at = p_required_at
    and seed.fyp_refreshed_at is null
    and (
      seed.fyp_refresh_claimed_at is null
      or seed.fyp_refresh_claimed_at < clock_timestamp() - interval '30 minutes'
    )
    and not exists (
      select 1
      from public.seeds as other
      where other.user_id = owner_id
        and other.id <> p_seed_id
        and other.fyp_refreshed_at is null
        and other.fyp_refresh_claimed_at >= clock_timestamp() - interval '30 minutes'
    )
  returning seed.fyp_refresh_claimed_at into claim_token;

  return claim_token;
end;
$$;

revoke all on function public.claim_seed_fyp_refresh(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_seed_fyp_refresh(uuid, timestamptz) to service_role;

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
    new.fyp_refresh_claimed_at := null;
  end if;

  return new;
end;
$$;
