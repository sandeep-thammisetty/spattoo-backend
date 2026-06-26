-- ── order_statuses ────────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Promotes order status from a free-text column policed only by a JS array into a
-- real, managed lookup table with referential integrity + display metadata. This
-- is the canonical order lifecycle.
--
-- DESIGN: this lookup is bounded (~10 rows, forever — it's an enum with metadata).
-- It carries a surrogate `id` (smallint PK) AND a readable `key` (UNIQUE). The HIGH-
-- VOLUME `orders` table references the compact `id` (see order_status_surrogate.sql),
-- not the text key — because at millions of orders the text value bloats the row and
-- every status index. The readable `key` is preserved for humans + queries; the API
-- joins to expose it, so callers still speak keys ('ready'), never magic numbers.
-- Statuses are DATA: add/retire one, or re-label/re-order, by editing rows here.
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

-- ── orders.status storage ─────────────────────────────────────────────────────
-- How orders REFERENCE this lookup lives in `order_status_surrogate.sql`, run after
-- this file. orders stores a compact smallint `status_id` FK → order_statuses(id),
-- NOT the text key — text on a million-row table bloats the row + every status index.
-- (See the surrogate migration + INVARIANTS "design for scale".)

-- ── Quote fields on the order (per the Pricing & Quote plan §3) ────────────────
-- suggested_price is internal-only (the baker's algorithm starting point); the
-- customer only ever sees quoted_price / final_price.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS suggested_price   numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quoted_price      numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_line_items  jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_valid_until timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_price       numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS priced_at         timestamptz;
