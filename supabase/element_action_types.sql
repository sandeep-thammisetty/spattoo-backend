-- Master data: defines every capability key an element can have.
-- The allowed_actions JSONB on cake_elements is validated against these keys.

create table element_action_types (
  id            uuid        primary key default gen_random_uuid(),
  key           text        not null unique,        -- machine key used in allowed_actions JSON
  label         text        not null,               -- shown in admin UI
  description   text,                               -- shown as hint beneath the checkbox
  default_value boolean     not null default false, -- fallback when key is absent on an element
  sort_order    integer     not null default 0,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now()
);

comment on table element_action_types is
  'Master list of per-element capability flags. Keys here map 1-to-1 to keys inside cake_elements.allowed_actions.';

-- ── Seed rows ─────────────────────────────────────────────────────────────────

insert into element_action_types (key, label, description, default_value, sort_order) values
  ('resize', 'Resizable',        'Show drag handle so the customer can resize this element on the canvas.',       true,  1),
  ('color',  'Color changeable', 'Show a color picker in the designer (applies to untextured GLB models only).', false, 2),
  ('delete', 'Deletable',        'Show a Remove button when the element is selected.',                           true,  3);

-- ── Add allowed_actions column to cake_elements (idempotent) ──────────────────

alter table cake_elements
  add column if not exists allowed_actions jsonb not null default '{"resize": true, "color": false, "delete": true}'::jsonb;

-- Back-fill any rows that have a null or empty object so they get proper defaults.
update cake_elements
set allowed_actions = '{"resize": true, "color": false, "delete": true}'::jsonb
where allowed_actions is null
   or allowed_actions = '{}'::jsonb;
