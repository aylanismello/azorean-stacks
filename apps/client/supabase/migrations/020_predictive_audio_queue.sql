-- Predictive, bounded audio preparation state.
-- The shared tracks table remains metadata-only; this table is per-user intent/state.

create table if not exists audio_preparation_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  state text not null default 'ranked'
    check (state in ('ranked', 'preparing', 'ready', 'failed', 'consumed')),
  rank integer not null check (rank > 0),
  score double precision not null default 0,
  score_components jsonb not null default '{}'::jsonb,
  scoring_version text not null default 'taste_score_v1',
  ranked_at timestamptz not null default now(),
  preparing_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  consumed_at timestamptz,
  last_error text,
  expires_at timestamptz not null default (now() + interval '7 days'),
  updated_at timestamptz not null default now(),
  unique (user_id, track_id)
);

create index if not exists idx_audio_preparation_user_active
  on audio_preparation_queue(user_id, state, rank)
  where state in ('ranked', 'preparing', 'ready');
create index if not exists idx_audio_preparation_track_active
  on audio_preparation_queue(track_id)
  where state in ('ranked', 'preparing', 'ready');
create index if not exists idx_audio_preparation_expiry
  on audio_preparation_queue(expires_at)
  where state in ('ranked', 'ready', 'failed', 'consumed');

alter table audio_preparation_queue enable row level security;
create policy "audio_preparation_select" on audio_preparation_queue
  for select using (auth.uid() = user_id);
create policy "audio_preparation_insert" on audio_preparation_queue
  for insert with check (auth.uid() = user_id);
create policy "audio_preparation_update" on audio_preparation_queue
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "audio_preparation_delete" on audio_preparation_queue
  for delete using (auth.uid() = user_id);

-- Explicit retention intent. Approved and super-liked tracks are protected regardless;
-- these flags cover manual/local archival intent that is independent of a vote.
alter table user_tracks add column if not exists permanent boolean not null default false;
alter table user_tracks add column if not exists local_download_intent boolean not null default false;
create index if not exists idx_user_tracks_audio_retention
  on user_tracks(track_id)
  where status = 'approved' or super_liked or permanent or local_download_intent;

-- Make approval re-seeding race-safe. Existing legacy rows may not have track_id,
-- so this intentionally applies only when a concrete source track is known.
create unique index if not exists idx_seeds_user_track_unique
  on seeds(user_id, track_id)
  where user_id is not null and track_id is not null;

comment on table audio_preparation_queue is
  'Per-user materialized upcoming ranking and bounded audio preparation lifecycle.';

-- Personalized scores must not overwrite the shared tracks row. Each user gets
-- an independently learned score and explainable component snapshot.
create table if not exists user_track_scores (
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  score double precision not null default 0,
  confidence double precision not null default 0,
  components jsonb not null default '{}'::jsonb,
  scoring_version text not null default 'taste_context_v2',
  scored_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists idx_user_track_scores_ranked
  on user_track_scores(user_id, score desc, confidence desc);

alter table user_track_scores enable row level security;
create policy "user_track_scores_select" on user_track_scores
  for select using (auth.uid() = user_id);

comment on table user_track_scores is
  'Per-user candidate scores. Never infer a user score from tracks.status or overwrite shared tracks.taste_score.';
