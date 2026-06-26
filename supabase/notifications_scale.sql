-- ── notifications: scale the hot poll + bound the table ────────────────────────
-- Run in the Supabase SQL editor. Idempotent.
--
-- notifications grows with EVERY email (kept forever once 'sent'), and the sweeper
-- polls `status='pending'` every ~30s. Two scale problems, fixed here:
--   1. the poll scans a forever-growing table for the few pending rows;
--   2. the table never shrinks.

-- 1. Partial index: contains ONLY pending rows (tiny + self-cleaning as they flip to
--    sent), so the sweeper's `WHERE status='pending'` stays O(pending) no matter how
--    many millions of 'sent' rows accumulate. Ordered by created_at for FIFO sends.
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (created_at)
  WHERE status = 'pending';

-- 2. Retention. notifications is an operational send-LOG (not business data we must
--    keep), so old 'sent' rows are purged rather than soft-deleted — otherwise the
--    table grows unbounded. Failures are NOT purged here (rare; useful for debugging).
CREATE OR REPLACE FUNCTION purge_old_notifications(retain_days int DEFAULT 90)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE deleted int;
BEGIN
  DELETE FROM notifications
   WHERE status = 'sent'
     AND COALESCE(sent_at, created_at) < now() - make_interval(days => retain_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;

-- 3. Schedule a nightly purge via pg_cron (best-effort: if pg_cron isn't enabled, the
--    index + function still apply and you run the purge from a job / the dashboard).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('purge-old-notifications', '17 3 * * *', 'SELECT purge_old_notifications(90);');
  RAISE NOTICE 'Scheduled nightly notification purge (03:17 UTC) via pg_cron.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not scheduled (%). The index + purge_old_notifications() are in place; run "SELECT purge_old_notifications(90);" from a job or manually.', SQLERRM;
END $$;
