-- ── order_statuses ────────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Promotes order status from a free-text column policed only by a JS array into a
-- real, managed lookup table with referential integrity + display metadata. This
-- is the canonical order lifecycle.
--
-- DESIGN: `key` is the natural primary key (a readable slug). `orders.status` stays
-- TEXT but becomes a FOREIGN KEY to order_statuses(key) — so it is no longer
-- uncontrolled text (the FK rejects any value not in this table), yet every
-- existing readable query (.eq('status','ready'), group-by status, UI
-- `status === 'delivered'`) keeps working unchanged, and we avoid magic-number ids.
-- Statuses are now DATA: add/retire one, or re-label/re-order, by editing rows here.
--
-- The lifecycle merges the quote phase (new) with the fulfillment phase (existing):
--   initiated → requested → quoted → confirmed → in_production → ready → completed
-- with declined / cancelled / expired as terminal off-ramps.
--   • `initiated`  — a design thread exists (baker-seeded base, or customer mid-design)
--                    but no quote has been requested yet. Entry point for the
--                    collaborative-design model (§1e of the plan).
--   • `requested`  — customer submitted / asked for a quote. Supersedes old `pending`.
--   • `confirmed`  — customer accepted the quote. Supersedes old `approved`.
--   • `in_production` / `completed` — supersede old `in_progress` / `delivered`.

CREATE TABLE IF NOT EXISTS order_statuses (
  key              text PRIMARY KEY,                       -- machine slug + the value stored on orders.status
  label            text NOT NULL,                          -- display label (baker UI)
  phase            text NOT NULL CHECK (phase IN ('quote','fulfillment','closed')),
  sort_order       int  NOT NULL,                          -- position on the lifecycle timeline
  is_terminal      boolean NOT NULL DEFAULT false,         -- no further transitions
  customer_visible boolean NOT NULL DEFAULT true,          -- shown on the customer's "your quote" view
  tone             text,                                   -- optional UI colour hint
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Seed / update the canonical lifecycle. ON CONFLICT keeps labels/ordering editable
-- by re-running this file.
INSERT INTO order_statuses (key, label, phase, sort_order, is_terminal, customer_visible, tone) VALUES
  ('initiated',     'Initiated',     'quote',        10, false, true,  'slate'),
  ('requested',     'Requested',     'quote',        20, false, true,  'amber'),
  ('quoted',        'Quoted',        'quote',        30, false, true,  'blue'),
  ('confirmed',     'Confirmed',     'fulfillment',  40, false, true,  'green'),
  ('in_production', 'In production', 'fulfillment',  50, false, true,  'violet'),
  ('ready',         'Ready',         'fulfillment',  60, false, true,  'teal'),
  ('completed',     'Completed',     'fulfillment',  70, true,  true,  'grey'),
  ('declined',      'Declined',      'closed',       80, true,  true,  'red'),
  ('cancelled',     'Cancelled',     'closed',       90, true,  true,  'red'),
  ('expired',       'Expired',       'closed',      100, true,  false, 'grey')
ON CONFLICT (key) DO UPDATE SET
  label            = EXCLUDED.label,
  phase            = EXCLUDED.phase,
  sort_order       = EXCLUDED.sort_order,
  is_terminal      = EXCLUDED.is_terminal,
  customer_visible = EXCLUDED.customer_visible,
  tone             = EXCLUDED.tone;

-- ── Migrate orders.status onto the lifecycle ──────────────────────────────────
-- Backfill legacy values BEFORE adding the FK so existing rows stay valid.
UPDATE orders SET status = 'requested'     WHERE status = 'pending';
UPDATE orders SET status = 'confirmed'     WHERE status = 'approved';
UPDATE orders SET status = 'in_production'  WHERE status = 'in_progress';
UPDATE orders SET status = 'completed'      WHERE status = 'delivered';

-- Remove deprecated status rows if a prior version of this file seeded them
-- (no orders reference these after the backfill above, so this is FK-safe).
DELETE FROM order_statuses WHERE key IN ('in_progress', 'delivered');

-- Default new orders to 'requested' (customer request / order placed, awaiting baker).
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'requested';

-- Fail loudly (naming the offenders) if any order still holds a status not in the
-- lookup — so the FK add below can't fail with a vague "violates foreign key" error.
-- If this fires, add the missing key to the seed above, or a backfill UPDATE for it.
DO $$
DECLARE orphans text;
BEGIN
  SELECT string_agg(DISTINCT o.status, ', ') INTO orphans
  FROM orders o
  WHERE o.status IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM order_statuses s WHERE s.key = o.status);
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION 'orders.status has values not in order_statuses: %', orphans;
  END IF;
END $$;

-- Add the FK once (ADD CONSTRAINT has no IF NOT EXISTS — guard it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_status_fkey
      FOREIGN KEY (status) REFERENCES order_statuses(key);
  END IF;
END $$;

-- ── Quote fields on the order (per the Pricing & Quote plan §3) ────────────────
-- suggested_price is internal-only (the baker's algorithm starting point); the
-- customer only ever sees quoted_price / final_price.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS suggested_price   numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quoted_price      numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_line_items  jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_valid_until timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_price       numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS priced_at         timestamptz;
