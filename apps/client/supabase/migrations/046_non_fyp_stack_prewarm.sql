-- Keep one current front track warm for each non-FYP stack so opening a
-- genre or seed destination can start immediately while its deeper queue fills.
create table if not exists public.non_fyp_stack_prewarm (
  user_id uuid not null references auth.users(id) on delete cascade,
  feed_key text not null check (length(feed_key) between 1 and 500),
  track_id uuid not null references public.tracks(id) on delete cascade,
  refreshed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, feed_key)
);

create index if not exists non_fyp_stack_prewarm_track_idx
  on public.non_fyp_stack_prewarm(track_id);
create index if not exists non_fyp_stack_prewarm_expiry_idx
  on public.non_fyp_stack_prewarm(expires_at);

alter table public.non_fyp_stack_prewarm enable row level security;

drop policy if exists "Users can view their stack prewarm rows"
  on public.non_fyp_stack_prewarm;
create policy "Users can view their stack prewarm rows"
  on public.non_fyp_stack_prewarm for select
  using (auth.uid() = user_id);

revoke insert, update, delete on public.non_fyp_stack_prewarm from public, anon, authenticated;
grant select on public.non_fyp_stack_prewarm to authenticated;
grant all on public.non_fyp_stack_prewarm to service_role;

-- Extend predictive-queue eviction protection to current non-FYP front tracks.
create or replace function public.evict_retired_queue_audio(p_warm_target integer default 20)
returns table(storage_path text)
language sql
security invoker
set search_path = public
as $$
  with protected_track_ids as materialized (
    select distinct ut.track_id
    from user_tracks ut
    where ut.status = 'approved'
       or ut.super_liked
       or ut.permanent
       or ut.local_download_intent
    union
    select distinct s.track_id
    from seeds s
    where s.track_id is not null and s.active = true
    union
    select distinct dr.track_id
    from download_requests dr
    where dr.track_id is not null and dr.status in ('pending', 'downloading')
    union
    select distinct q.track_id
    from audio_preparation_queue q
    where q.state in ('ranked', 'preparing', 'ready')
      and q.expires_at > now()
      and q.rank <= greatest(1, p_warm_target)
    union
    select distinct warm.track_id
    from non_fyp_stack_prewarm warm
    where warm.expires_at > now()
    union
    select t.id
    from tracks t
    where t.status = 'approved'
       or coalesce(t.is_seed, false)
       or coalesce(t.is_re_seed, false)
       or coalesce(t.is_artist_seed, false)
       or lower(coalesce(t.source, '')) in ('seed', 'manual', 'picodrops', 'pico_drops')
       or t.metadata @> '{"permanent": true}'::jsonb
       or t.metadata @> '{"keep_audio": true}'::jsonb
       or t.metadata @> '{"local_download_intent": true}'::jsonb
       or t.metadata @> '{"is_seed": true}'::jsonb
       or t.metadata @> '{"is_re_seed": true}'::jsonb
       or t.metadata @> '{"picodrop": true}'::jsonb
       or t.metadata @> '{"pico_drop": true}'::jsonb
       or t.metadata @> '{"pico_drops": true}'::jsonb
       or t.metadata @> '{"creator_supplied": true}'::jsonb
  ),
  retired_track_ids as materialized (
    select distinct q.track_id
    from audio_preparation_queue q
    where q.state = 'consumed'
      and not exists (
        select 1 from protected_track_ids protected where protected.track_id = q.track_id
      )
  ),
  candidate_paths as materialized (
    select distinct t.storage_path
    from tracks t
    join retired_track_ids retired on retired.track_id = t.id
    where t.storage_path is not null
  ),
  eligible_paths as materialized (
    select candidate.storage_path
    from candidate_paths candidate
    where not exists (
      select 1
      from tracks shared
      where shared.storage_path = candidate.storage_path
        and not exists (
          select 1 from retired_track_ids retired where retired.track_id = shared.id
        )
    )
  ),
  to_clear as materialized (
    select t.id, t.storage_path
    from tracks t
    join eligible_paths eligible on eligible.storage_path = t.storage_path
  ),
  cleared as (
    update tracks t
    set storage_path = null,
        download_url = null,
        downloaded_at = null
    from to_clear doomed
    where t.id = doomed.id
    returning doomed.storage_path
  )
  select distinct cleared.storage_path from cleared;
$$;

revoke all on function public.evict_retired_queue_audio(integer) from public, anon, authenticated;
grant execute on function public.evict_retired_queue_audio(integer) to service_role;

comment on table public.non_fyp_stack_prewarm is
  'Expiring front-track reservations for non-FYP genre, artist, and seed stacks.';
