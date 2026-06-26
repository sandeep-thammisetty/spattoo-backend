-- ── customers.auth_user_id ────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Links a customer (a baker-scoped person record) to the Supabase Auth user that
-- proves control of their contact (email/phone). Before this, the invite OTP flow
-- returned customer_id from the invite but never bound the authenticated user to
-- the customer row — so there was no way to derive "who the customer is" from a
-- session token. This column is that binding.
--
-- WHO SETS IT: the storefront OTP-verify handler, at the one moment it holds BOTH
-- the invite's customer_id AND the freshly minted session's user id. It is set only
-- when currently NULL (never overwrites an existing binding — no account takeover).
--
-- TENANCY: customers are per-baker, and one person (one auth user / one email) can
-- be a customer of several bakers — so auth_user_id is NOT globally unique. It is
-- unique PER BAKER: (baker_id, auth_user_id). Order routes resolve the customer by
-- (auth_user_id from the token) AND (baker_id from the storefront slug).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- One customer row per (baker, auth user). Partial: only rows that have been bound.
CREATE UNIQUE INDEX IF NOT EXISTS customers_baker_auth_user_uidx
  ON customers (baker_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Lookup path for "resolve customer from token, scoped to baker".
CREATE INDEX IF NOT EXISTS customers_auth_user_idx
  ON customers (auth_user_id)
  WHERE auth_user_id IS NOT NULL;
