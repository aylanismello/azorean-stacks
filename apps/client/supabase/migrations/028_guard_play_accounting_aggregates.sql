-- Keep play accounting server-owned even when authenticated users may update
-- other columns on their own user_tracks rows through RLS.

CREATE OR REPLACE FUNCTION public.guard_user_track_play_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF (TG_OP = 'INSERT' AND (NEW.play_count <> 0 OR NEW.total_listen_duration_ms <> 0))
       OR (TG_OP = 'UPDATE' AND (
         NEW.play_count IS DISTINCT FROM OLD.play_count
         OR NEW.total_listen_duration_ms IS DISTINCT FROM OLD.total_listen_duration_ms
       )) THEN
      RAISE EXCEPTION 'play accounting fields are server-managed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_user_track_play_accounting() FROM PUBLIC;

-- The session ledger outlives the aggregate row. Prevent browser roles from
-- deleting that row and resetting their visible totals; server/worker cleanup
-- continues to run as service_role.
REVOKE DELETE ON TABLE public.user_tracks FROM anon, authenticated;

DROP TRIGGER IF EXISTS guard_user_track_play_accounting
  ON public.user_tracks;

CREATE TRIGGER guard_user_track_play_accounting
BEFORE INSERT OR UPDATE OF play_count, total_listen_duration_ms
ON public.user_tracks
FOR EACH ROW
EXECUTE FUNCTION public.guard_user_track_play_accounting();
