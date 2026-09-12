-- Ranking evidence is observed by trusted application servers, never authored
-- directly by browser clients.
revoke all on function public.record_ranking_exposures(jsonb) from public, anon, authenticated;
revoke all on function public.record_ranking_outcome(uuid, text) from public, anon, authenticated;
drop function if exists public.record_ranking_exposures(jsonb);
drop function if exists public.record_ranking_outcome(uuid, text);

create or replace function public.record_ranking_exposures(
  p_user_id uuid,
  p_rows jsonb
)
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

  insert into public.ranking_exposures (
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
$$ language plpgsql security definer set search_path = '';

create or replace function public.record_ranking_outcome(
  p_user_id uuid,
  p_track_id uuid,
  p_outcome text
)
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
  from public.ranking_exposures
  where user_id = p_user_id
    and track_id = p_track_id
    and exposed_at < recorded_at
  order by exposed_at desc, id desc
  limit 1;

  if selected_exposure_id is null then
    return false;
  end if;

  insert into public.ranking_outcomes (exposure_id, user_id, track_id, outcome, outcome_at)
  values (selected_exposure_id, p_user_id, p_track_id, p_outcome, recorded_at)
  on conflict (exposure_id) do nothing;
  return found;
end;
$$ language plpgsql security definer set search_path = '';

revoke all on function public.record_ranking_exposures(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_ranking_outcome(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_ranking_exposures(uuid, jsonb) to service_role;
grant execute on function public.record_ranking_outcome(uuid, uuid, text) to service_role;
