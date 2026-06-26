-- ── notification type: quote issued ──────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to the customer when the baker issues/re-issues a quote (price + link).

INSERT INTO notification_types (slug, label) VALUES
  ('quote_issued_customer', 'Quote issued — customer notification')
ON CONFLICT (slug) DO NOTHING;
