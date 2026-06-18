-- Image → 3D wizard: one row per Meshy.ai image-to-3D generation.
--
-- This is the durable source of truth for a generation (survives tab close / server restart).
-- Lifecycle: PENDING → IN_PROGRESS → SUCCEEDED | FAILED. The row is advanced by EITHER the
-- account-global Meshy webhook (prod fast path) OR an on-read live poll in GET /admin/meshy/:id
-- (local dev, where the webhook can't reach localhost; also a missed-webhook fallback in prod).
-- finalizeOrUpdate() is idempotent so the two paths can't double-download or double-count credits.
--
-- Terminal rows are KEPT as the credit/audit trail (soft-delete convention) — never hard-deleted.

CREATE TABLE meshy_generations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       uuid,                                  -- req.user.id (auth user); becomes baker_id when baker-facing
  source_image_key text NOT NULL,                         -- R2 key under meshy/source/
  meshy_task_id    text UNIQUE,                            -- Meshy task id (matched by the webhook)
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED')),
  progress         integer NOT NULL DEFAULT 0,            -- 0–100, mirrors Meshy
  glb_key          text,                                  -- R2 key under meshy/outputs/ (our copy of the GLB)
  thumbnail_url    text,                                  -- Meshy front-view thumbnail
  consumed_credits integer,                               -- credits Meshy charged
  error            text,                                  -- task_error message on FAILED
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meshy_generations_task_idx   ON meshy_generations(meshy_task_id);
CREATE INDEX meshy_generations_status_idx ON meshy_generations(status);
