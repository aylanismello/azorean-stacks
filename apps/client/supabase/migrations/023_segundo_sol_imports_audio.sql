-- Segundo Sol Sessions source imports and private audio handoff.

alter table segundo_sol_episode_tracks
  add column if not exists audio_status text not null default 'not_requested'
    check (audio_status in ('not_requested', 'pending', 'processing', 'downloaded', 'reused', 'failed')),
  add column if not exists audio_storage_path text,
  add column if not exists audio_error text,
  add column if not exists audio_requested_at timestamptz,
  add column if not exists audio_completed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'segundo_sol_episode_tracks_id_user_unique'
  ) then
    alter table segundo_sol_episode_tracks
      add constraint segundo_sol_episode_tracks_id_user_unique unique (id, user_id);
  end if;
end $$;

create table if not exists segundo_sol_import_jobs (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  source_type text not null
    check (source_type in ('spotify', 'soundcloud', 'bandcamp', 'youtube')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  total_count integer not null default 0 check (total_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (episode_id, user_id)
    references segundo_sol_episodes(id, user_id) on delete cascade
);

create table if not exists segundo_sol_download_requests (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null,
  episode_track_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  result_storage_path text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (episode_id, user_id)
    references segundo_sol_episodes(id, user_id) on delete cascade,
  foreign key (episode_track_id, user_id)
    references segundo_sol_episode_tracks(id, user_id) on delete cascade
);

create index if not exists idx_segundo_sol_import_jobs_pending
  on segundo_sol_import_jobs(status, created_at)
  where status = 'pending';
create index if not exists idx_segundo_sol_download_requests_pending
  on segundo_sol_download_requests(status, created_at)
  where status = 'pending';
create unique index if not exists idx_segundo_sol_download_requests_active
  on segundo_sol_download_requests(episode_track_id)
  where status in ('pending', 'processing');

alter table segundo_sol_import_jobs enable row level security;
alter table segundo_sol_download_requests enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'segundo_sol_import_jobs',
    'segundo_sol_download_requests'
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
  'segundo-sol-audio',
  'segundo-sol-audio',
  false,
  52428800,
  array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/wav']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "segundo_sol_audio_user_read" on storage.objects;
create policy "segundo_sol_audio_user_read" on storage.objects
  for select using (
    bucket_id = 'segundo-sol-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

comment on table segundo_sol_import_jobs is
  'Authenticated source imports consumed by the local PicoDrops worker.';
comment on table segundo_sol_download_requests is
  'Auditable per-track acquisition requests consumed by the local PicoDrops worker.';
