-- Replace text status column with status_id int on baker_subscriptions.
-- Status IDs: 1=active 2=pending 3=paused 4=past_due 5=expired 6=cancelled

ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS status_id int;

UPDATE baker_subscriptions SET status_id = CASE status
  WHEN 'active'    THEN 1
  WHEN 'pending'   THEN 2
  WHEN 'paused'    THEN 3
  WHEN 'past_due'  THEN 4
  WHEN 'expired'   THEN 5
  WHEN 'cancelled' THEN 6
  ELSE 1
END WHERE status_id IS NULL;

ALTER TABLE baker_subscriptions ALTER COLUMN status_id SET NOT NULL;
ALTER TABLE baker_subscriptions ALTER COLUMN status_id SET DEFAULT 1;
ALTER TABLE baker_subscriptions DROP COLUMN IF EXISTS status;

-- Dropping the status column invalidates both RPCs — recreate them.
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
    CASE bs.status_id
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'pending'
      WHEN 3 THEN 'paused'
      WHEN 4 THEN 'past_due'
      WHEN 5 THEN 'expired'
      WHEN 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS status,
    CASE
      WHEN bs.status_id = 1 AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
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

DROP FUNCTION IF EXISTS get_baker_subscriptions_admin();
CREATE FUNCTION get_baker_subscriptions_admin()
RETURNS TABLE (
  baker_id         uuid,
  baker_name       text,
  plan_name        text,
  period_name      text,
  status           text,
  derived_status   text,
  end_date         date,
  start_date       date
)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (b.id)
    b.id            AS baker_id,
    b.name          AS baker_name,
    sp.name         AS plan_name,
    bp.name         AS period_name,
    CASE bs.status_id
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'pending'
      WHEN 3 THEN 'paused'
      WHEN 4 THEN 'past_due'
      WHEN 5 THEN 'expired'
      WHEN 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS status,
    CASE
      WHEN bs.status_id = 1 AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS derived_status,
    bs.end_date,
    bs.start_date
  FROM bakers b
  LEFT JOIN baker_subscriptions bs ON bs.baker_id = b.id
  LEFT JOIN subscription_plans  sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods     bp ON bp.id = bs.billing_period_id
  ORDER BY b.id, bs.created_at DESC;
$$;
