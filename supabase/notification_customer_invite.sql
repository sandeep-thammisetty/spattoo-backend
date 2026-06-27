-- ── notification type: customer invite ───────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to a customer when a baker invites them to a design session
-- (private storefront link; OTP gates access). Replaces the old inline SMTP send
-- in routes/customers.js — invites now flow through the durable notification outbox.

INSERT INTO notification_types (slug, label) VALUES
  ('customer_invite', 'Customer invited to design session')
ON CONFLICT (slug) DO NOTHING;
