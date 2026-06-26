-- ── notifications.status → native enum ─────────────────────────────────────────
-- Run in the Supabase SQL editor. Idempotent. Backward-compatible with the app
-- (PostgREST reads/writes the enum as a string, so `status='sent'` keeps working).
--
-- status is an INTERNAL pipeline state machine (pending → enqueued → sent/failed),
-- code-owned with no labels/metadata to manage — so a native ENUM is the right fit:
-- type-safe (no bad values), compact, readable, no lookup-table join. (A managed
-- lookup table + surrogate FK is for MASTER data like order_statuses, not this.)

-- 1. The enum type.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM ('pending', 'enqueued', 'sent', 'failed');
  END IF;
END $$;

-- 2. Convert the column (only if it's still text). The partial index references
--    status, so drop it first and recreate after the type change.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'status' AND data_type = 'text'
  ) THEN
    -- Drop any CHECK constraint on status (e.g. status IN ('pending',...)) — it's
    -- stored as `status = ANY(text[])` and would become `enum = text` after the type
    -- change (the "operator does not exist" error). The enum itself enforces the set.
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END;

    DROP INDEX IF EXISTS notifications_pending_idx;
    ALTER TABLE notifications ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE notifications
      ALTER COLUMN status TYPE notification_status USING status::notification_status;
    ALTER TABLE notifications ALTER COLUMN status SET DEFAULT 'pending';
  END IF;
END $$;

-- 3. (Re)create the partial index for the sweeper backstop poll.
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (created_at) WHERE status = 'pending';
