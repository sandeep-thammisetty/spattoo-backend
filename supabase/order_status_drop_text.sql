-- ── Expand/contract step 3: drop the legacy orders.status text column ──────────
-- Run this ONLY AFTER the status_id-based API code is deployed and verified live.
-- Until then the text column is kept (nullable) so old code can still run during the
-- deploy — see order_status_surrogate.sql. Idempotent.
ALTER TABLE orders DROP COLUMN IF EXISTS status;
