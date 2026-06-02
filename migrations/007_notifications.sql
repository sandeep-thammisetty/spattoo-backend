-- Notification types
CREATE TABLE notification_types (
  id    serial PRIMARY KEY,
  slug  text NOT NULL UNIQUE,
  label text NOT NULL
);

INSERT INTO notification_types (slug, label) VALUES
  ('order_placed_baker',    'Order placed — baker notification'),
  ('order_placed_customer', 'Order placed — customer confirmation');

-- Notifications queue table
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id         integer NOT NULL REFERENCES notification_types(id),
  recipient_email text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message   text,
  sent_at         timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_status_idx ON notifications(status);
