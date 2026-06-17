-- ── Customer storefront ───────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Baker "story" for the customer-facing storefront (logo + story + brand colours).
-- (Invite plumbing lives in its own table — see customer_invites.sql.)
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS story text;
