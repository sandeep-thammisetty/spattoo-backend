-- ── notification type: design updated by baker ────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- When the baker edits the design while it's still open (initiated / quoted — the
-- shared-pen window), the customer is emailed that the baker has recommendations /
-- updated the design. One type covers both; the email copy varies by payload.mode.

INSERT INTO notification_types (slug, label) VALUES
  ('design_updated_customer', 'Design updated by baker — customer notification')
ON CONFLICT (slug) DO NOTHING;
