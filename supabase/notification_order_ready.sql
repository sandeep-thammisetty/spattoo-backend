-- ── notification type: order ready ───────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to the customer when the baker marks the order ready (for pickup or
-- delivery), before it's completed.

INSERT INTO notification_types (slug, label) VALUES
  ('order_ready_customer', 'Order ready for pickup/delivery — customer notification')
ON CONFLICT (slug) DO NOTHING;
