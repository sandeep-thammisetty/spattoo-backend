-- Bakery's public business address, shown on the storefront. Optional; captured in
-- the onboarding brand wizard (or later in settings). Bakery-level (not per appuser).
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS address text;
