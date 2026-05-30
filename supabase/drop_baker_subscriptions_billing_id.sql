-- billing_subscription_id (Razorpay subscription ID) is a baker-level concept.
-- It now lives exclusively on bakers.billing_subscription_id.

DROP INDEX IF EXISTS baker_subscriptions_billing_sub_id_idx;
ALTER TABLE baker_subscriptions DROP COLUMN IF EXISTS billing_subscription_id;

-- Update the RPC to no longer return the dropped column.
DROP FUNCTION IF EXISTS get_baker_subscription(uuid);
CREATE FUNCTION get_baker_subscription(p_baker_id uuid)
RETURNS TABLE (
  id                  uuid,
  plan_id             int,
  plan_name           text,
  plan_display_name   text,
  period_name         text,
  period_display_name text,
  status              text,
  derived_status      text,
  start_date          date,
  end_date            date
)
LANGUAGE sql STABLE AS $$
  SELECT
    bs.id,
    sp.id           AS plan_id,
    sp.name         AS plan_name,
    sp.display_name AS plan_display_name,
    bp.name         AS period_name,
    bp.display_name AS period_display_name,
    bs.status,
    CASE
      WHEN bs.status = 'active' AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      ELSE bs.status
    END             AS derived_status,
    bs.start_date,
    bs.end_date
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods    bp ON bp.id = bs.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY bs.created_at DESC
  LIMIT 1;
$$;
