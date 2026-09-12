-- Explicit user-scoped seed tangents. Routine queue refreshes never create one.

create table if not exists public.user_fyp_tangents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  seed_id uuid references public.seeds(id) on delete set null,
  seed_artist text not null,
  seed_title text not null,
  seed_source text,
  refresh_required_at timestamptz not null,
  generation bigint not null check (generation > 0),
  track_ids uuid[] not null default '{}',
  added_track_ids uuid[] not null default '{}',
  moved_track_ids uuid[] not null default '{}',
  removed_track_ids uuid[] not null default '{}',
  track_snapshots jsonb not null default '[]'::jsonb,
  removed_track_snapshots jsonb not null default '[]'::jsonb,
  start_rank integer check (start_rank is null or start_rank > 0),
  protected_prefix integer not null default 5 check (protected_prefix >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, seed_id, refresh_required_at),
  check (cardinality(track_ids) <= 3)
);

create index if not exists user_fyp_tangents_user_created_idx
  on public.user_fyp_tangents(user_id, created_at desc);

alter table public.user_fyp_tangents enable row level security;
alter table public.user_fyp_tangents force row level security;

drop policy if exists "user_fyp_tangents_select" on public.user_fyp_tangents;
create policy "user_fyp_tangents_select"
  on public.user_fyp_tangents
  for select
  using (auth.uid() = user_id);

revoke all on public.user_fyp_tangents from public, anon, authenticated;
grant select on public.user_fyp_tangents to authenticated;
grant all on public.user_fyp_tangents to service_role;

create or replace function public.publish_fyp_tangent(
  p_user_id uuid,
  p_seed_id uuid,
  p_refresh_required_at timestamptz,
  p_track_ids uuid[] default '{}',
  p_added_track_ids uuid[] default '{}',
  p_moved_track_ids uuid[] default '{}',
  p_removed_track_ids uuid[] default '{}',
  p_start_rank integer default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  next_generation bigint;
  existing_generation bigint;
  seed_row record;
begin
  if cardinality(coalesce(p_track_ids, '{}')) = 0 then
    raise exception 'a tangent must contain at least one affected track';
  end if;
  if cardinality(coalesce(p_track_ids, '{}')) > 3 then
    raise exception 'a tangent may contain at most three affected tracks';
  end if;

  select id, artist, title, source into seed_row
  from public.seeds
  where id = p_seed_id
    and user_id = p_user_id
    and active = true
    and fyp_refresh_required_at = p_refresh_required_at;
  if not found then
    raise exception 'seed tangent owner or refresh generation mismatch';
  end if;

  -- A retry after queue materialization must reuse the first durable event and
  -- must not publish a second generation or erase the original delta.
  select generation into existing_generation
  from public.user_fyp_tangents
  where user_id = p_user_id
    and seed_id = p_seed_id
    and refresh_required_at = p_refresh_required_at;
  if existing_generation is not null then
    return existing_generation;
  end if;

  insert into public.user_fyp_generations (user_id, generation, reason, seed_id, updated_at)
  values (p_user_id, 1, 'seed_refresh', p_seed_id, clock_timestamp())
  on conflict (user_id) do update
    set generation = public.user_fyp_generations.generation + 1,
        reason = 'seed_refresh',
        seed_id = p_seed_id,
        updated_at = excluded.updated_at
  returning generation into next_generation;

  insert into public.user_fyp_tangents (
    user_id, seed_id, seed_artist, seed_title, seed_source,
    refresh_required_at, generation, track_ids, added_track_ids,
    moved_track_ids, removed_track_ids, track_snapshots,
    removed_track_snapshots, start_rank
  )
  values (
    p_user_id, p_seed_id, seed_row.artist, seed_row.title, seed_row.source,
    p_refresh_required_at, next_generation, coalesce(p_track_ids, '{}'),
    coalesce(p_added_track_ids, '{}'), coalesce(p_moved_track_ids, '{}'),
    coalesce(p_removed_track_ids, '{}'),
    coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'artist', t.artist, 'title', t.title, 'cover_art_url', t.cover_art_url) order by ids.ordinality)
      from unnest(coalesce(p_track_ids, '{}')) with ordinality ids(track_id, ordinality)
      join public.tracks t on t.id = ids.track_id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'artist', t.artist, 'title', t.title, 'cover_art_url', t.cover_art_url) order by ids.ordinality)
      from unnest(coalesce(p_removed_track_ids, '{}')) with ordinality ids(track_id, ordinality)
      join public.tracks t on t.id = ids.track_id
    ), '[]'::jsonb),
    p_start_rank
  );

  return next_generation;
end;
$$;

revoke all on function public.publish_fyp_tangent(uuid, uuid, timestamptz, uuid[], uuid[], uuid[], uuid[], integer)
  from public, anon, authenticated;
grant execute on function public.publish_fyp_tangent(uuid, uuid, timestamptz, uuid[], uuid[], uuid[], uuid[], integer)
  to service_role;
