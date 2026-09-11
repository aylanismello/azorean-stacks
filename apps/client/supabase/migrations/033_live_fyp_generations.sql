-- Durable, user-scoped 4U generations for realtime client reconciliation.

create table if not exists public.user_fyp_generations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  reason text not null default 'ranking_refresh' check (reason in ('ranking_refresh', 'seed_refresh')),
  seed_id uuid references public.seeds(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.user_fyp_generations enable row level security;
alter table public.user_fyp_generations force row level security;

drop policy if exists "user_fyp_generations_select" on public.user_fyp_generations;
create policy "user_fyp_generations_select"
  on public.user_fyp_generations
  for select
  using (auth.uid() = user_id);

revoke all on public.user_fyp_generations from public, anon, authenticated;
grant select on public.user_fyp_generations to authenticated;
grant all on public.user_fyp_generations to service_role;

create or replace function public.publish_fyp_generation(
  p_user_id uuid,
  p_reason text default 'ranking_refresh',
  p_seed_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  next_generation bigint;
begin
  if p_reason not in ('ranking_refresh', 'seed_refresh') then
    raise exception 'invalid FYP generation reason';
  end if;

  insert into public.user_fyp_generations (user_id, generation, reason, seed_id, updated_at)
  values (p_user_id, 1, p_reason, p_seed_id, clock_timestamp())
  on conflict (user_id) do update
    set generation = public.user_fyp_generations.generation + 1,
        reason = excluded.reason,
        seed_id = excluded.seed_id,
        updated_at = excluded.updated_at
  returning generation into next_generation;

  return next_generation;
end;
$$;

revoke all on function public.publish_fyp_generation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.publish_fyp_generation(uuid, text, uuid) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'user_fyp_generations'
  ) then
    alter publication supabase_realtime add table public.user_fyp_generations;
  end if;
end;
$$;
