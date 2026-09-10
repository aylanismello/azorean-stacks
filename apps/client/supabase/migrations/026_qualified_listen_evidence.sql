-- Persist qualified listen evidence and its soft status in one row-level write.
-- Explicit votes remain authoritative if they race with the 80% player event.
create or replace function record_qualified_track_listen(
  p_user_id uuid,
  p_track_id uuid,
  p_listen_pct integer,
  p_listen_duration_ms integer
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
begin
  if p_listen_pct < 80 or p_listen_pct > 100 then
    raise exception 'listen_pct must be between 80 and 100';
  end if;
  if p_listen_duration_ms < 0 then
    raise exception 'listen_duration_ms must be non-negative';
  end if;

  insert into user_tracks (
    user_id,
    track_id,
    status,
    listen_pct,
    listen_duration_ms
  ) values (
    p_user_id,
    p_track_id,
    'listened',
    p_listen_pct,
    p_listen_duration_ms
  )
  on conflict (user_id, track_id) do update
  set
    status = case
      when user_tracks.status in ('pending', 'listened') then 'listened'
      else user_tracks.status
    end,
    listen_pct = greatest(coalesce(user_tracks.listen_pct, 0), excluded.listen_pct),
    listen_duration_ms = greatest(coalesce(user_tracks.listen_duration_ms, 0), excluded.listen_duration_ms)
  returning status into v_status;

  return v_status;
end;
$$;
