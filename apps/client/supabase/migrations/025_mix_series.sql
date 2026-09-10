-- Shared Mix Series catalog, per-user series seeds, and lossless episode appearances.

create table if not exists mix_series (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text,
  source text not null,
  source_url text not null,
  artwork_url text,
  featured boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_series_seeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  series_id uuid not null references mix_series(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, series_id)
);
create index if not exists idx_user_series_seeds_user_created
  on user_series_seeds(user_id, created_at desc);

-- Selecting/starting an episode is durable user state, not a track opinion.
create table if not exists user_episode_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  series_id uuid not null references mix_series(id) on delete cascade,
  episode_id uuid not null references episodes(id) on delete cascade,
  last_position integer not null default 0 check (last_position >= 0),
  current_position integer not null default 0 check (current_position >= 0),
  state text not null default 'active' check (state in ('active', 'completed')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, episode_id)
);
create index if not exists idx_user_episode_sessions_user_updated
  on user_episode_sessions(user_id, updated_at desc);

alter table episodes
  add column if not exists series_id uuid references mix_series(id) on delete set null,
  add column if not exists source_id text,
  add column if not exists release_date date,
  add column if not exists description text,
  add column if not exists dj_id text,
  add column if not exists dj_name text,
  add column if not exists soundcloud_url text,
  add column if not exists apple_music_url text;
create unique index if not exists idx_episodes_series_source_id
  on episodes(series_id, source_id) where series_id is not null and source_id is not null;
create index if not exists idx_episodes_series_release
  on episodes(series_id, release_date desc, crawled_at desc);

-- Lossless source appearance identity is additive. The legacy episode_tracks
-- table remains the deduplicated analytics junction for existing consumers.
create table if not exists episode_track_entries (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  track_id uuid references tracks(id) on delete set null,
  position integer not null check (position >= 0),
  timestamp_text text,
  timestamp_seconds integer check (timestamp_seconds is null or timestamp_seconds >= 0),
  source_artist text,
  source_title text,
  source_artist_id text,
  source_song_id text,
  resolution_state text not null default 'unresolved'
    check (resolution_state in ('canonical', 'unresolved', 'unavailable')),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (episode_id, position),
  check (track_id is not null or source_artist is not null or source_title is not null)
);
create index if not exists idx_episode_track_entries_track
  on episode_track_entries(track_id) where track_id is not null;
create index if not exists idx_episode_track_entries_source_song
  on episode_track_entries(source_song_id) where source_song_id is not null;

alter table mix_series enable row level security;
alter table user_series_seeds enable row level security;
alter table user_episode_sessions enable row level security;
alter table user_episode_sessions force row level security;
alter table episode_track_entries enable row level security;
drop policy if exists "mix_series_select" on mix_series;
create policy "mix_series_select" on mix_series for select using (true);
drop policy if exists "episode_track_entries_select" on episode_track_entries;
create policy "episode_track_entries_select" on episode_track_entries for select using (true);

drop policy if exists "user_series_seeds_select" on user_series_seeds;
drop policy if exists "user_series_seeds_insert" on user_series_seeds;
drop policy if exists "user_series_seeds_delete" on user_series_seeds;
create policy "user_series_seeds_select" on user_series_seeds for select using (auth.uid() = user_id);
create policy "user_series_seeds_insert" on user_series_seeds for insert with check (auth.uid() = user_id);
create policy "user_series_seeds_delete" on user_series_seeds for delete using (auth.uid() = user_id);

drop policy if exists "user_episode_sessions_select" on user_episode_sessions;
drop policy if exists "user_episode_sessions_insert" on user_episode_sessions;
drop policy if exists "user_episode_sessions_update" on user_episode_sessions;
drop policy if exists "user_episode_sessions_delete" on user_episode_sessions;
create policy "user_episode_sessions_select" on user_episode_sessions for select using (auth.uid() = user_id);
create policy "user_episode_sessions_insert" on user_episode_sessions for insert with check (auth.uid() = user_id);
create policy "user_episode_sessions_update" on user_episode_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Shared source rows are browser-readable but browser writes remain worker-only.
drop policy if exists "episodes_insert" on episodes;
drop policy if exists "episodes_update" on episodes;

comment on table mix_series is 'Shared, worker-managed radio and DJ mix series.';
comment on table user_series_seeds is 'A user follows a series; this never implies episode-track eligibility.';
comment on table user_episode_sessions is 'Owner-scoped durable episode selection and playback position; never a track opinion.';
comment on table episode_track_entries is 'Lossless ordered source appearances; track_id is nullable for unresolved rows.';
