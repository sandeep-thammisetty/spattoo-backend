-- Tags controlled vocabulary
CREATE TABLE IF NOT EXISTS tags (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  slug          text        NOT NULL UNIQUE,
  category      text        NOT NULL CHECK (category IN ('occasion','style','color','material','theme','age_group','gender')),
  ai_assignable boolean     NOT NULL DEFAULT false,
  sort_order    integer     NOT NULL DEFAULT 0,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Element → tag junction
CREATE TABLE IF NOT EXISTS element_tags (
  element_id  uuid  NOT NULL REFERENCES cake_elements(id) ON DELETE CASCADE,
  tag_id      uuid  NOT NULL REFERENCES tags(id)          ON DELETE CASCADE,
  source      text  NOT NULL DEFAULT 'manual' CHECK (source IN ('ai','manual')),
  confidence  real           CHECK (confidence >= 0 AND confidence <= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (element_id, tag_id)
);

-- Template → tag junction
CREATE TABLE IF NOT EXISTS template_tags (
  template_id uuid  NOT NULL REFERENCES cake_templates(id) ON DELETE CASCADE,
  tag_id      uuid  NOT NULL REFERENCES tags(id)           ON DELETE CASCADE,
  source      text  NOT NULL DEFAULT 'manual' CHECK (source IN ('ai','manual')),
  confidence  real           CHECK (confidence >= 0 AND confidence <= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, tag_id)
);

-- Template structured search attributes (1:1 companion, grows here not on cake_templates)
CREATE TABLE IF NOT EXISTS cake_template_attrs (
  template_id   uuid         PRIMARY KEY REFERENCES cake_templates(id) ON DELETE CASCADE,
  min_weight_kg decimal(5,2) CHECK (min_weight_kg > 0),
  min_age       smallint     CHECK (min_age >= 0),
  max_age       smallint     CHECK (max_age >= 0),
  CONSTRAINT age_range_valid CHECK (max_age IS NULL OR min_age IS NULL OR max_age >= min_age),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_element_tags_element ON element_tags(element_id);
CREATE INDEX IF NOT EXISTS idx_element_tags_tag     ON element_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_template_tags_tmpl   ON template_tags(template_id);
CREATE INDEX IF NOT EXISTS idx_template_tags_tag    ON template_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tags_category        ON tags(category) WHERE is_active = true;

-- ── Seed initial vocabulary ───────────────────────────────────────────────────
INSERT INTO tags (name, slug, category, ai_assignable, sort_order) VALUES
  -- Occasion
  ('Birthday',       'birthday',     'occasion', true,  10),
  ('Wedding',        'wedding',      'occasion', true,  20),
  ('Anniversary',    'anniversary',  'occasion', true,  30),
  ('Baby Shower',    'baby-shower',  'occasion', true,  40),
  ('Graduation',     'graduation',   'occasion', true,  50),
  ('Christmas',      'christmas',    'occasion', true,  60),
  ('Easter',         'easter',       'occasion', true,  70),
  ('Halloween',      'halloween',    'occasion', true,  80),
  ('Eid',            'eid',          'occasion', true,  90),
  ('Diwali',         'diwali',       'occasion', true, 100),
  ('Valentine''s',   'valentines',   'occasion', true, 110),
  -- Style
  ('Floral',         'floral',       'style',    true,  10),
  ('Modern',         'modern',       'style',    true,  20),
  ('Rustic',         'rustic',       'style',    true,  30),
  ('Vintage',        'vintage',      'style',    true,  40),
  ('Minimalist',     'minimalist',   'style',    true,  50),
  ('Tropical',       'tropical',     'style',    true,  60),
  ('Boho',           'boho',         'style',    true,  70),
  ('Elegant',        'elegant',      'style',    true,  80),
  ('Whimsical',      'whimsical',    'style',    true,  90),
  ('Geometric',      'geometric',    'style',    true, 100),
  -- Color
  ('Pink',           'pink',         'color',    true,  10),
  ('White',          'white',        'color',    true,  20),
  ('Ivory',          'ivory',        'color',    true,  30),
  ('Gold',           'gold',         'color',    true,  40),
  ('Silver',         'silver',       'color',    true,  50),
  ('Green',          'green',        'color',    true,  60),
  ('Blue',           'blue',         'color',    true,  70),
  ('Red',            'red',          'color',    true,  80),
  ('Black',          'black',        'color',    true,  90),
  ('Purple',         'purple',       'color',    true, 100),
  ('Multi-color',    'multi-color',  'color',    true, 110),
  -- Material
  ('Fondant',        'fondant',      'material', true,  10),
  ('Buttercream',    'buttercream',  'material', true,  20),
  ('Acrylic',        'acrylic',      'material', true,  30),
  ('Sugar',          'sugar',        'material', true,  40),
  ('Metallic',       'metallic',     'material', true,  50),
  ('Wafer Paper',    'wafer-paper',  'material', true,  60),
  ('Fresh Flowers',  'fresh-flowers','material', true,  70),
  -- Theme
  ('Unicorn',        'unicorn',      'theme',    true,  10),
  ('Sports',         'sports',       'theme',    true,  20),
  ('Space',          'space',        'theme',    true,  30),
  ('Nature',         'nature',       'theme',    true,  40),
  ('Music',          'music',        'theme',    true,  50),
  ('Princess',       'princess',     'theme',    true,  60),
  ('Superhero',      'superhero',    'theme',    true,  70),
  ('Beach',          'beach',        'theme',    true,  80),
  ('Fairy Tale',     'fairy-tale',   'theme',    true,  90),
  ('Cars & Vehicles','cars-vehicles','theme',    true, 100),
  -- Age group (manual only — AI cannot determine intended age target)
  ('Baby (0–1)',     'baby',         'age_group', false, 10),
  ('Toddler (2–3)',  'toddler',      'age_group', false, 20),
  ('Kids (4–12)',    'kids',         'age_group', false, 30),
  ('Teen (13–17)',   'teen',         'age_group', false, 40),
  ('Adult (18+)',    'adult',        'age_group', false, 50),
  -- Gender (manual only — absence means all genders)
  ('Boys',           'boys',         'gender',   false, 10),
  ('Girls',          'girls',        'gender',   false, 20)
ON CONFLICT (slug) DO NOTHING;
