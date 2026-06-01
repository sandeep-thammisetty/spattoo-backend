-- Free-text description for each cake element.
-- Admin writes a natural-language description; designer search queries against it.
-- Example: "Colorful rainbow arc with fluffy white clouds. Great for unicorn and birthday themes."

ALTER TABLE cake_elements
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
