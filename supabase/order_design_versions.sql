-- ── order_design_versions ─────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- A design is a SINGLE evolving artifact with an append-only version history (plan
-- §1e). Each refinement — by the customer OR the baker (shared pen, pre-confirm) —
-- is a NEW row here, never an in-place overwrite, so the negotiation history and
-- audit survive. A quote pins to the version it priced (orders.quoted_version_id);
-- when the design advances past it (current_version_id moves on), the quote is
-- "stale" and must be re-affirmed or re-quoted.
--
-- orders.design_snapshot / design_thumbnail_url remain as a DENORMALIZED mirror of
-- the current version, so existing reads (OrdersPanel, X-Ray, dashboard) keep
-- working untouched; current_version_id is the normalized pointer.

CREATE TABLE IF NOT EXISTS order_design_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  version_no           int  NOT NULL,                       -- 1-based, monotonic per order
  design_snapshot      jsonb NOT NULL,
  design_thumbnail_url text,
  authored_by          text NOT NULL CHECK (authored_by IN ('customer', 'baker')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version_no)
);

CREATE INDEX IF NOT EXISTS order_design_versions_order_idx
  ON order_design_versions (order_id, version_no);

-- Pointers on the order: the live version, and the version a quote was priced for.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS current_version_id uuid REFERENCES order_design_versions(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quoted_version_id  uuid REFERENCES order_design_versions(id);

-- Backfill: every existing order with a design gets a version 1 from its current
-- snapshot, and current_version_id pointed at it. Idempotent via the NULL guard.
DO $$
DECLARE r record; v_id uuid;
BEGIN
  FOR r IN
    SELECT id, design_snapshot, design_thumbnail_url
    FROM orders
    WHERE current_version_id IS NULL AND design_snapshot IS NOT NULL
  LOOP
    INSERT INTO order_design_versions (order_id, version_no, design_snapshot, design_thumbnail_url, authored_by)
    VALUES (r.id, 1, r.design_snapshot, r.design_thumbnail_url, 'customer')
    RETURNING id INTO v_id;
    UPDATE orders SET current_version_id = v_id WHERE id = r.id;
  END LOOP;
END $$;
