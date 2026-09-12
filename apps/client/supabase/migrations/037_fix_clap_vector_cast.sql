-- Qualify the pgvector type inside the restricted search_path function.
create or replace function public.complete_sonic_embedding_job(
  p_job_id uuid,
  p_owner uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_embedding text,
  p_model_id text,
  p_model_revision text,
  p_embedding_version text,
  p_segment_windows jsonb,
  p_sound_labels jsonb default '[]'::jsonb,
  p_audio_fingerprint text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_track_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select j.track_id into v_track_id
  from public.sonic_embedding_jobs j
  where j.id = p_job_id and j.state = 'leased'
    and j.lease_owner = p_owner and j.lease_token = p_lease_token
    and j.lease_generation = p_lease_generation
    and j.lease_expires_at > now()
  for update;
  if v_track_id is null then return false; end if;

  insert into public.track_sonic_embeddings (
    track_id, embedding, model_id, model_revision, embedding_version,
    segment_windows, sound_labels, audio_fingerprint, embedded_at, updated_at
  ) values (
    v_track_id, p_embedding::public.vector(512), p_model_id, p_model_revision,
    p_embedding_version, p_segment_windows, coalesce(p_sound_labels, '[]'::jsonb),
    p_audio_fingerprint, now(), now()
  )
  on conflict (track_id) do update set
    embedding = excluded.embedding,
    model_id = excluded.model_id,
    model_revision = excluded.model_revision,
    embedding_version = excluded.embedding_version,
    segment_windows = excluded.segment_windows,
    sound_labels = excluded.sound_labels,
    audio_fingerprint = excluded.audio_fingerprint,
    embedded_at = excluded.embedded_at,
    updated_at = excluded.updated_at;

  update public.sonic_embedding_jobs
  set state = 'completed', completed_at = now(), updated_at = now(),
      lease_owner = null, lease_token = null, lease_expires_at = null, last_error = null
  where id = p_job_id;
  return true;
end;
$$;

revoke all on function public.complete_sonic_embedding_job(uuid, uuid, uuid, bigint, text, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_sonic_embedding_job(uuid, uuid, uuid, bigint, text, text, text, text, jsonb, jsonb, text) to service_role;
