-- Keep behavioral playback accounting separate from curation eligibility.
-- A listen may update these totals without creating a user_tracks relationship.

CREATE TABLE IF NOT EXISTS public.user_track_play_totals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES public.tracks(id) ON DELETE CASCADE,
  play_count bigint NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  total_listen_duration_ms bigint NOT NULL DEFAULT 0
    CHECK (total_listen_duration_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_id)
);

ALTER TABLE public.user_track_play_totals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_track_play_totals_select"
  ON public.user_track_play_totals;
CREATE POLICY "user_track_play_totals_select"
  ON public.user_track_play_totals
  FOR SELECT
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.user_track_play_totals
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_track_play_totals TO authenticated;
GRANT ALL ON TABLE public.user_track_play_totals TO service_role;

-- Preserve any values recorded during the brief migration-027 compatibility
-- window. GREATEST makes this replay-safe instead of adding them twice.
INSERT INTO public.user_track_play_totals (
  user_id, track_id, play_count, total_listen_duration_ms
)
SELECT user_id, track_id, play_count, total_listen_duration_ms
FROM public.user_tracks
WHERE play_count > 0 OR total_listen_duration_ms > 0
ON CONFLICT (user_id, track_id) DO UPDATE
SET play_count = GREATEST(
      public.user_track_play_totals.play_count,
      EXCLUDED.play_count
    ),
    total_listen_duration_ms = GREATEST(
      public.user_track_play_totals.total_listen_duration_ms,
      EXCLUDED.total_listen_duration_ms
    ),
    updated_at = now();

CREATE OR REPLACE FUNCTION public.record_user_track_play_chunk(
  p_user_id uuid,
  p_track_id uuid,
  p_session_id uuid,
  p_listened_ms bigint
)
RETURNS TABLE(
  session_listened_ms bigint,
  qualified boolean,
  play_count bigint,
  total_listen_duration_ms bigint,
  status text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_previous_listened_ms bigint;
  v_previous_qualified boolean;
  v_new_listened_ms bigint;
  v_delta_ms bigint;
  v_became_qualified boolean;
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_listened_ms < 30000 OR p_listened_ms % 30000 <> 0 THEN
    RAISE EXCEPTION 'listened_ms must be a positive multiple of 30000'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_track_play_sessions (
    user_id, track_id, session_id, listened_ms, qualified
  ) VALUES (
    p_user_id, p_track_id, p_session_id, 0, false
  )
  ON CONFLICT (user_id, track_id, session_id) DO NOTHING;

  SELECT s.listened_ms, s.qualified
    INTO v_previous_listened_ms, v_previous_qualified
  FROM public.user_track_play_sessions s
  WHERE s.user_id = p_user_id
    AND s.track_id = p_track_id
    AND s.session_id = p_session_id
  FOR UPDATE;

  v_new_listened_ms := GREATEST(v_previous_listened_ms, p_listened_ms);
  v_delta_ms := v_new_listened_ms - v_previous_listened_ms;
  v_became_qualified := NOT v_previous_qualified
    AND v_new_listened_ms >= 30000;

  UPDATE public.user_track_play_sessions s
  SET listened_ms = v_new_listened_ms,
      qualified = v_previous_qualified OR v_became_qualified,
      updated_at = now()
  WHERE s.user_id = p_user_id
    AND s.track_id = p_track_id
    AND s.session_id = p_session_id;

  INSERT INTO public.user_track_play_totals (
    user_id, track_id, play_count, total_listen_duration_ms
  ) VALUES (
    p_user_id,
    p_track_id,
    CASE WHEN v_became_qualified THEN 1 ELSE 0 END,
    v_delta_ms
  )
  ON CONFLICT (user_id, track_id) DO UPDATE
  SET play_count = public.user_track_play_totals.play_count
        + EXCLUDED.play_count,
      total_listen_duration_ms = public.user_track_play_totals.total_listen_duration_ms
        + EXCLUDED.total_listen_duration_ms,
      updated_at = now();

  RETURN QUERY
  SELECT
    v_new_listened_ms,
    v_previous_qualified OR v_became_qualified,
    totals.play_count,
    totals.total_listen_duration_ms,
    opinions.status
  FROM public.user_track_play_totals totals
  LEFT JOIN public.user_tracks opinions
    ON opinions.user_id = totals.user_id
   AND opinions.track_id = totals.track_id
  WHERE totals.user_id = p_user_id
    AND totals.track_id = p_track_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_track_play_chunk(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_track_play_chunk(uuid, uuid, uuid, bigint)
  TO service_role;

COMMENT ON TABLE public.user_track_play_totals IS
  'Per-user behavioral playback totals, isolated from user_tracks curation eligibility';
COMMENT ON COLUMN public.user_tracks.play_count IS
  'Deprecated compatibility column; playback totals live in user_track_play_totals';
COMMENT ON COLUMN public.user_tracks.total_listen_duration_ms IS
  'Deprecated compatibility column; playback totals live in user_track_play_totals';
