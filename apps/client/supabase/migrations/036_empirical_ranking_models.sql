-- Prospective empirical-ranking evidence and gated candidate configuration.
-- Feature snapshots and their attributed outcomes are append-only; evaluation
-- must never reconstruct either side from mutable user_tracks state.

create table if not exists user_ranking_model_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  model_version text not null,
  feature_schema_version text not null default 'production_ranking_features_v1',
  weights jsonb not null,
  intercept double precision not null,
  training_sample_count integer not null default 0 check (training_sample_count >= 0),
  trained_through timestamptz,
  evaluation jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(weights) = 'object'),
  check (weights ?& array[
    'artist', 'genre', 'seed', 'curator', 'source_context',
    'episode_density', 'co_occurrence', 'sonic_similarity'
  ]::text[]),
  check (
    jsonb_typeof(weights->'artist') = 'number'
    and jsonb_typeof(weights->'genre') = 'number'
    and jsonb_typeof(weights->'seed') = 'number'
    and jsonb_typeof(weights->'curator') = 'number'
    and jsonb_typeof(weights->'source_context') = 'number'
    and jsonb_typeof(weights->'episode_density') = 'number'
    and jsonb_typeof(weights->'co_occurrence') = 'number'
    and jsonb_typeof(weights->'sonic_similarity') = 'number'
  ),
  check (
    (weights->>'artist')::double precision between 0.02 and 0.30
    and (weights->>'genre')::double precision between 0.02 and 0.30
    and (weights->>'seed')::double precision between 0.02 and 0.30
    and (weights->>'curator')::double precision between 0.02 and 0.30
    and (weights->>'source_context')::double precision between 0.02 and 0.30
    and (weights->>'episode_density')::double precision between 0.02 and 0.30
    and (weights->>'co_occurrence')::double precision between 0.02 and 0.30
    and (weights->>'sonic_similarity')::double precision between 0.02 and 0.30
  ),
  -- The current production scorer's seven taste weights sum to 1.0 and its
  -- independently bounded sonic term contributes weight 0.10.
  check (abs(
    (weights->>'artist')::double precision
    + (weights->>'genre')::double precision
    + (weights->>'seed')::double precision
    + (weights->>'curator')::double precision
    + (weights->>'source_context')::double precision
    + (weights->>'episode_density')::double precision
    + (weights->>'co_occurrence')::double precision
    + (weights->>'sonic_similarity')::double precision
    - 1.10
  ) < 0.000001),
  check (intercept between -4 and 4)
);

alter table user_ranking_model_config enable row level security;
create policy "user_ranking_model_config_select" on user_ranking_model_config
  for select using (auth.uid() = user_id);
revoke insert, update, delete on user_ranking_model_config from anon, authenticated;

comment on table user_ranking_model_config is
  'A gated per-user ranking candidate. Only service-role evaluation may replace it after strict prospective evidence and holdout gates pass.';

create table if not exists ranking_exposures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete restrict,
  request_id text not null check (length(request_id) between 1 and 200),
  surface text not null default 'fyp' check (length(surface) between 1 and 80),
  rank integer not null check (rank > 0),
  -- Raw relative production score. It is intentionally not called a
  -- probability and may include signed penalties and bounded bonuses.
  predicted_score double precision not null check (predicted_score between -4 and 4),
  score_components jsonb not null,
  model_version text not null check (length(model_version) between 1 and 200),
  feature_schema_version text not null default 'production_ranking_features_v1',
  exposed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, request_id, track_id),
  unique (id, user_id, track_id),
  check (jsonb_typeof(score_components) = 'object'),
  check (score_components ?& array[
    'artist', 'genre', 'seed', 'curator', 'source_context',
    'episode_density', 'co_occurrence', 'sonic_similarity'
  ]::text[]),
  check (
    (score_components->>'artist')::double precision between -1 and 1
    and (score_components->>'genre')::double precision between -1 and 1
    and (score_components->>'seed')::double precision between -1 and 1
    and (score_components->>'curator')::double precision between -1 and 1
    and (score_components->>'source_context')::double precision between -1 and 1
    and (score_components->>'episode_density')::double precision between -1 and 1
    and (score_components->>'co_occurrence')::double precision between -1 and 1
    and (score_components->>'sonic_similarity')::double precision between -1 and 1
  )
);

create index if not exists idx_ranking_exposures_user_chronology
  on ranking_exposures(user_id, exposed_at, id);
create index if not exists idx_ranking_exposures_user_track_chronology
  on ranking_exposures(user_id, track_id, exposed_at desc, id desc);

alter table ranking_exposures enable row level security;
create policy "ranking_exposures_select" on ranking_exposures
  for select using (auth.uid() = user_id);
revoke insert, update, delete on ranking_exposures from anon, authenticated;

create table if not exists ranking_outcomes (
  id uuid primary key default gen_random_uuid(),
  exposure_id uuid not null unique,
  user_id uuid not null,
  track_id uuid not null,
  outcome text not null check (outcome in ('approved', 'rejected', 'skipped', 'listened')),
  outcome_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (exposure_id, user_id, track_id)
    references ranking_exposures(id, user_id, track_id) on delete cascade
);

create index if not exists idx_ranking_outcomes_user_chronology
  on ranking_outcomes(user_id, outcome_at, id);

alter table ranking_outcomes enable row level security;
create policy "ranking_outcomes_select" on ranking_outcomes
  for select using (auth.uid() = user_id);
revoke insert, update, delete on ranking_outcomes from anon, authenticated;

create or replace function prevent_ranking_evidence_mutation()
returns trigger as $$
begin
  -- Permit only referential cleanup initiated by deletion of the owning user or
  -- parent exposure. Ordinary direct mutation, including service-role mutation,
  -- remains forbidden.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;
  if tg_op = 'DELETE' and tg_table_name = 'ranking_outcomes' and not exists (
    select 1 from ranking_exposures where id = old.exposure_id
  ) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql set search_path = public, pg_temp;

drop trigger if exists ranking_exposures_immutable on ranking_exposures;
create trigger ranking_exposures_immutable
  before update or delete on ranking_exposures
  for each row execute function prevent_ranking_evidence_mutation();

drop trigger if exists ranking_outcomes_immutable on ranking_outcomes;
create trigger ranking_outcomes_immutable
  before update or delete on ranking_outcomes
  for each row execute function prevent_ranking_evidence_mutation();

-- Clients cannot choose exposed_at: database receipt time is the causal boundary.
-- Retries of one rendered slate are idempotent by request/track.
create or replace function record_ranking_exposures(p_user_id uuid, p_rows jsonb)
returns integer as $$
declare
  inserted_count integer;
  recorded_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' or p_user_id is null then
    raise exception 'service role required';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100 then
    raise exception 'p_rows must contain between 1 and 100 exposures';
  end if;

  insert into ranking_exposures (
    user_id, track_id, request_id, surface, rank, predicted_score,
    score_components, model_version, feature_schema_version, exposed_at
  )
  select
    p_user_id,
    (row->>'track_id')::uuid,
    row->>'request_id',
    coalesce(nullif(row->>'surface', ''), 'fyp'),
    (row->>'rank')::integer,
    (row->>'predicted_score')::double precision,
    row->'score_components',
    row->>'model_version',
    coalesce(nullif(row->>'feature_schema_version', ''), 'production_ranking_features_v1'),
    recorded_at
  from jsonb_array_elements(p_rows) as row
  on conflict (user_id, request_id, track_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Atomically bind a decision to the latest exposure that existed before the
-- server received the outcome. One exposure can yield at most one label.
create or replace function record_ranking_outcome(p_user_id uuid, p_track_id uuid, p_outcome text)
returns boolean as $$
declare
  recorded_at timestamptz := clock_timestamp();
  selected_exposure_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' or p_user_id is null then
    raise exception 'service role required';
  end if;
  if p_outcome not in ('approved', 'rejected', 'skipped', 'listened') then
    raise exception 'invalid ranking outcome';
  end if;

  select id into selected_exposure_id
  from ranking_exposures
  where user_id = p_user_id
    and track_id = p_track_id
    and exposed_at < recorded_at
  order by exposed_at desc, id desc
  limit 1;

  if selected_exposure_id is null then
    return false;
  end if;

  insert into ranking_outcomes (exposure_id, user_id, track_id, outcome, outcome_at)
  values (selected_exposure_id, p_user_id, p_track_id, p_outcome, recorded_at)
  on conflict (exposure_id) do nothing;
  return found;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function record_ranking_exposures(uuid, jsonb) from public, anon, authenticated;
revoke all on function record_ranking_outcome(uuid, uuid, text) from public, anon, authenticated;
grant execute on function record_ranking_exposures(uuid, jsonb) to service_role;
grant execute on function record_ranking_outcome(uuid, uuid, text) to service_role;

comment on table ranking_exposures is
  'Append-only pre-outcome production feature and score snapshots at database-recorded presentation time.';
comment on table ranking_outcomes is
  'Append-only outcomes atomically attributed to one strictly earlier immutable exposure.';
comment on column ranking_exposures.score_components is
  'All eight signed -1..1 scorer inputs; absent production evidence must be explicitly frozen as zero.';
