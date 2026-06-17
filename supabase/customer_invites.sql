-- ── customer_invites ──────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- An invite is an EVENT: "baker invited this customer to a design session."
-- A customer can be invited many times (1:many), so this is its own table, not a
-- column on customers.
--
-- Access model (MVP): access is baker-initiated and invite-gated. There is no
-- anytime self-serve customer login. After OTP verifies the contact, login is
-- granted only if a VALID invite exists (status active + now < expires_at). The
-- baker context comes from the invite — never a global customer session.
--
-- The row `id` IS the link reference: /<baker-slug>?invite=<id>. It grants NOTHING
-- on its own (no access without OTP); it only identifies the invite. So no separate
-- token column.
--
-- OTP itself is handled by Supabase Auth (passwordless) — Supabase owns code
-- generation/expiry/attempts, so there is no codes table here. `expires_at` below
-- is the INVITE (link) expiry — the login gate — not the OTP expiry.

CREATE TABLE IF NOT EXISTS customer_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- also the link ref: ?invite=<id>
  baker_id    uuid NOT NULL REFERENCES bakers(id)    ON DELETE CASCADE,  -- denormalized (immutable) for tenancy/RLS
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channels    text[] NOT NULL DEFAULT '{email}',            -- one or more: email | sms | whatsapp | link
  status      text   NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','opened','completed','expired','revoked')),
  note        text,                                          -- optional occasion, e.g. "Riya's 5th birthday"
  sent_at     timestamptz,
  opened_at   timestamptz,
  expires_at  timestamptz,                                   -- the login gate (NULL = no expiry)
  created_by  uuid REFERENCES baker_appusers(id),            -- which staff sent it (audit)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_invites_customer_idx ON customer_invites (customer_id);
CREATE INDEX IF NOT EXISTS customer_invites_baker_idx    ON customer_invites (baker_id);
CREATE INDEX IF NOT EXISTS customer_invites_status_idx   ON customer_invites (status);
