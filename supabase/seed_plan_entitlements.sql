-- Per-plan entitlement values → subscription_plans.features (jsonb). The code
-- registry (src/constants/entitlements.js) defines the KEYS + fallbacks; these are
-- the VALUES the resolver reads. Idempotent (plain UPDATE by stable plan name).
-- null on an int key = unlimited. Keep in sync with the registry + marketing pricing.

update subscription_plans set features = jsonb_build_object(
  'storefront', false, 'custom_branding', false, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', false,
  'max_orders_per_month', 10, 'max_team_members', 1
) where name = 'spark';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', false, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', true, 'xray_reports', false,
  'max_orders_per_month', null, 'max_team_members', 2
) where name = 'flame';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', true, 'xray_reports', true,
  'max_orders_per_month', null, 'max_team_members', 5
) where name = 'blaze';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', true, 'xray_reports', true,
  'max_orders_per_month', null, 'max_team_members', null
) where name = 'forge';
