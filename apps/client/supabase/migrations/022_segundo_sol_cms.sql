-- Segundo Sol Sessions private planning studio
-- Private per-user episode planning, track snapshots, inspiration mixes, artwork.

create table if not exists segundo_sol_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  episode_number integer not null check (episode_number > 0),
  title text not null default '',
  theme text,
  status text not null default 'draft'
    check (status in ('draft', 'assembling', 'ready', 'published')),
  notes text,
  artwork_url text,
  artwork_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, episode_number),
  unique (id, user_id)
);

create table if not exists segundo_sol_episode_tracks (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid references tracks(id) on delete set null,
  position integer not null check (position >= 0),
  artist text not null,
  title text not null,
  source_origin text not null default 'manual'
    check (source_origin in ('stacks_like', 'stacks_super_like', 'manual')),
  source_type text not null default 'other'
    check (source_type in ('stacks', 'spotify', 'soundcloud', 'bandcamp', 'youtube', 'other')),
  source_url text,
  artwork_url text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  role text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (episode_id, user_id)
    references segundo_sol_episodes(id, user_id) on delete cascade
);

create table if not exists segundo_sol_inspirations (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  position integer not null check (position >= 0),
  title text not null,
  creator text,
  source_type text not null default 'other'
    check (source_type in ('spotify', 'soundcloud', 'bandcamp', 'youtube', 'mixcloud', 'other')),
  source_url text not null,
  artwork_url text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (episode_id, user_id)
    references segundo_sol_episodes(id, user_id) on delete cascade
);

alter table segundo_sol_episode_tracks
  drop constraint if exists segundo_sol_episode_tracks_source_shape;
alter table segundo_sol_episode_tracks
  add constraint segundo_sol_episode_tracks_source_shape check (
    (source_origin = 'manual' and track_id is null and source_url is not null)
    or
    (source_origin in ('stacks_like', 'stacks_super_like') and track_id is not null)
  );

create index if not exists idx_segundo_sol_episodes_user_updated
  on segundo_sol_episodes(user_id, updated_at desc);
create index if not exists idx_segundo_sol_tracks_episode_position
  on segundo_sol_episode_tracks(episode_id, position);
create index if not exists idx_segundo_sol_inspirations_episode_position
  on segundo_sol_inspirations(episode_id, position);
create unique index if not exists idx_segundo_sol_tracks_catalog_unique
  on segundo_sol_episode_tracks(episode_id, track_id)
  where track_id is not null;
create unique index if not exists idx_segundo_sol_tracks_source_unique
  on segundo_sol_episode_tracks(episode_id, source_url)
  where source_url is not null;
create unique index if not exists idx_segundo_sol_inspirations_source_unique
  on segundo_sol_inspirations(episode_id, source_url);

create or replace function segundo_sol_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function segundo_sol_validate_track_source()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  selected_status text;
  selected_super_liked boolean;
begin
  if new.source_origin = 'manual' then
    return new;
  end if;

  select ut.status, ut.super_liked
    into selected_status, selected_super_liked
  from user_tracks ut
  where ut.user_id = new.user_id
    and ut.track_id = new.track_id;

  if not found or selected_status <> 'approved' then
    raise exception 'Catalog track must be approved by the episode owner'
      using errcode = '23514';
  end if;

  if new.source_origin = 'stacks_super_like'
     and selected_super_liked is not true then
    raise exception 'Track is not super-liked by the episode owner'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists segundo_sol_episodes_touch_updated_at on segundo_sol_episodes;
create trigger segundo_sol_episodes_touch_updated_at
  before update on segundo_sol_episodes
  for each row execute function segundo_sol_touch_updated_at();

drop trigger if exists segundo_sol_tracks_touch_updated_at on segundo_sol_episode_tracks;
create trigger segundo_sol_tracks_touch_updated_at
  before update on segundo_sol_episode_tracks
  for each row execute function segundo_sol_touch_updated_at();

drop trigger if exists segundo_sol_tracks_validate_source on segundo_sol_episode_tracks;
create trigger segundo_sol_tracks_validate_source
  before insert or update of user_id, track_id, source_origin
  on segundo_sol_episode_tracks
  for each row execute function segundo_sol_validate_track_source();

alter table segundo_sol_episodes enable row level security;
alter table segundo_sol_episode_tracks enable row level security;
alter table segundo_sol_inspirations enable row level security;

-- API routes also scope every service-role query by user_id. These policies protect
-- direct authenticated-client access and keep the storage model safe by default.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'segundo_sol_episodes',
    'segundo_sol_episode_tracks',
    'segundo_sol_inspirations'
  ]
  loop
    execute format('drop policy if exists %I on %I', table_name || '_select', table_name);
    execute format(
      'create policy %I on %I for select using (auth.uid() = user_id)',
      table_name || '_select', table_name
    );
    execute format('drop policy if exists %I on %I', table_name || '_insert', table_name);
    execute format(
      'create policy %I on %I for insert with check (auth.uid() = user_id)',
      table_name || '_insert', table_name
    );
    execute format('drop policy if exists %I on %I', table_name || '_update', table_name);
    execute format(
      'create policy %I on %I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      table_name || '_update', table_name
    );
    execute format('drop policy if exists %I on %I', table_name || '_delete', table_name);
    execute format(
      'create policy %I on %I for delete using (auth.uid() = user_id)',
      table_name || '_delete', table_name
    );
  end loop;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'segundo-sol-artwork',
  'segundo-sol-artwork',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "segundo_sol_artwork_public_read" on storage.objects;
create policy "segundo_sol_artwork_public_read" on storage.objects
  for select using (bucket_id = 'segundo-sol-artwork');

drop policy if exists "segundo_sol_artwork_user_insert" on storage.objects;
create policy "segundo_sol_artwork_user_insert" on storage.objects
  for insert with check (
    bucket_id = 'segundo-sol-artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "segundo_sol_artwork_user_update" on storage.objects;
create policy "segundo_sol_artwork_user_update" on storage.objects
  for update using (
    bucket_id = 'segundo-sol-artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'segundo-sol-artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "segundo_sol_artwork_user_delete" on storage.objects;
create policy "segundo_sol_artwork_user_delete" on storage.objects
  for delete using (
    bucket_id = 'segundo-sol-artwork'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

comment on table segundo_sol_episodes is
  'Private Segundo Sol episode drafts owned by one authenticated user.';
comment on table segundo_sol_episode_tracks is
  'Ordered immutable-enough track metadata snapshots for Segundo Sol drafts.';
comment on table segundo_sol_inspirations is
  'Mixes and playlists that inform a Segundo Sol episode arc.';
