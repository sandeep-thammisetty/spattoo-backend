-- ── Add the quote_approved state + advance/quote-note fields + notifications ────
-- Run in the Supabase SQL editor. Idempotent. Also normalizes the lifecycle to the
-- canonical set + ordering (safe whether or not the earlier relabel was applied).

-- 1. Lifecycle: ensure canonical keys exist (id-stable relabels for the retired ones).
INSERT INTO order_statuses (key, label, phase, sort_order, is_terminal, customer_visible, tone)
VALUES ('initiated', 'Initiated', 'quote', 10, false, true, 'slate')
ON CONFLICT (key) DO NOTHING;

UPDATE order_statuses SET key='in_production', label='In production', phase='fulfillment', tone='violet' WHERE key='in_progress';
UPDATE order_statuses SET key='completed',     label='Completed',     phase='fulfillment', is_terminal=true, tone='grey' WHERE key='delivered';

-- The new state: customer approved the quote (design + price agreed and LOCKED),
-- awaiting the advance → baker confirms. Sits between 'quoted' and 'confirmed'.
-- phase='fulfillment' (NOT 'quote') so the design is locked here (isQuotePhase=false).
INSERT INTO order_statuses (key, label, phase, sort_order, is_terminal, customer_visible, tone)
VALUES ('quote_approved', 'Quote approved', 'fulfillment', 35, false, true, 'teal')
ON CONFLICT (key) DO UPDATE SET
  label=EXCLUDED.label, phase=EXCLUDED.phase, sort_order=EXCLUDED.sort_order,
  is_terminal=EXCLUDED.is_terminal, customer_visible=EXCLUDED.customer_visible, tone=EXCLUDED.tone;

-- Canonical timeline ordering.
UPDATE order_statuses SET sort_order=10  WHERE key='initiated';
UPDATE order_statuses SET sort_order=20  WHERE key='requested';
UPDATE order_statuses SET sort_order=30  WHERE key='quoted';
UPDATE order_statuses SET sort_order=35  WHERE key='quote_approved';
UPDATE order_statuses SET sort_order=40  WHERE key='confirmed';
UPDATE order_statuses SET sort_order=50  WHERE key='in_production';
UPDATE order_statuses SET sort_order=60  WHERE key='ready';
UPDATE order_statuses SET sort_order=70  WHERE key='completed';
UPDATE order_statuses SET sort_order=80  WHERE key='declined';
UPDATE order_statuses SET sort_order=90  WHERE key='cancelled';
UPDATE order_statuses SET sort_order=100 WHERE key='expired';

-- 2. Quote-time fields (baker sets advance + a personal note when issuing the quote;
--    advance_paid_at is stamped when the baker confirms the order).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_amount  numeric(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_note      text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_paid_at timestamptz;

-- 3. New notification types.
INSERT INTO notification_types (slug, label) VALUES
  ('order_confirmed_customer', 'Order confirmed — customer notification'),
  ('quote_question_baker',     'Customer question on the quote — baker notification')
ON CONFLICT (slug) DO NOTHING;
