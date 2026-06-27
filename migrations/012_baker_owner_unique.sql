-- ── 012: one bakery per owner (auth user) ────────────────────────────────────
-- Business rule: a single Supabase auth user owns AT MOST ONE baker. This is the
-- inverse of the customer model — a customer may belong to MANY bakers (unique
-- PER baker: (baker_id, auth_user_id), see customer_auth_link.sql); an OWNER is
-- unique GLOBALLY.
--
-- Enforced on the STABLE identity `auth_user_id`, never the text email: email is
-- already unique in auth.users, and `bakers.email` is a separate business-contact
-- field (nullable). One email → one auth user → (with this index) one baker.
--
-- Multi-business (same person, two separate bakeries) is intentionally out of
-- scope — rare, and handled as separate registrations if it ever arises.
-- Multi-location (one bakery, many delivery origins) is a future
-- baker_locations-under-one-baker concern, NOT multiple baker accounts.
--
-- ⚠️ This FAILS to apply while duplicate owner rows exist. Run the dupe-finder
-- first and delete the extras (see notes), then apply.

-- One baker per owning auth user. Partial (WHERE NOT NULL) so legacy/unclaimed
-- bakers with a null auth_user_id are unaffected (multiple NULLs stay allowed).
CREATE UNIQUE INDEX IF NOT EXISTS bakers_auth_user_id_uidx
  ON bakers (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- No duplicate membership rows for the same user within one baker (mirrors the
-- customers (baker_id, auth_user_id) unique). Does NOT restrict a user from
-- being a member of different bakers — only one row per (baker, user).
CREATE UNIQUE INDEX IF NOT EXISTS baker_appusers_baker_auth_uidx
  ON baker_appusers (baker_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL;
