-- ── notification type: quote accepted ────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to the baker when the customer accepts a quote (order confirmed).

INSERT INTO notification_types (slug, label) VALUES
  ('quote_accepted_baker', 'Quote accepted — baker notification')
ON CONFLICT (slug) DO NOTHING;
