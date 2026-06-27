-- ── notification type: order completed ───────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to the customer when the baker marks the order complete (delivered /
-- picked up) — a thank-you note closing the loop.

INSERT INTO notification_types (slug, label) VALUES
  ('order_completed_customer', 'Order completed — customer thank-you')
ON CONFLICT (slug) DO NOTHING;
