import { supabase } from './supabase.js';
import { logSubscriptionEvent } from '../routes/subscriptions.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';

// Slugs that must never be claimed by a baker storefront (routes / infra names).
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'www', 'app', 'dashboard', 'baker', 'bakers', 'signup', 'signin',
  'login', 'logout', 'support', 'help', 'about', 'pricing', 'blog', 'static',
  'assets', 'storefront', 'orders', 'design', 'invite', 'billing',
]);

// Canonicalise a free-text business name (or raw slug) into a storefront slug.
export function normalizeSlug(s) {
  return String(s ?? '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// 3–40 chars, lowercase alphanumerics + internal hyphens (no leading/trailing hyphen).
export function isValidSlug(s) {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s);
}

export async function slugTaken(slug) {
  const { data } = await supabase.from('bakers').select('id').eq('slug', slug).maybeSingle();
  return !!data;
}

// Create the baker's DB rows for an ALREADY-EXISTING auth user (caller owns the
// Supabase Auth user lifecycle): `bakers` + `baker_appusers` (owner/primary) + a
// Spark (free, 30-day) `baker_subscriptions` row + the subscription event, and mirror
// plan/status onto the baker. Rolls back the baker row if the appuser insert fails;
// does NOT touch Supabase Auth. Throws on failure.
//
// Shared by admin onboarding (POST /admin/bakers, which first creates the auth user)
// and self-signup (POST /bakers/self, which uses the authenticated req.user) — ONE
// creation path so the two never drift.
export async function createBakerForUser({
  authUserId, name, slug,
  email, tagline, instagram_handle, website_url,
  primary_color, accent_color, logo_url,
  currency_code, timezone, primaryUser,
}) {
  const { data, error } = await supabase
    .from('bakers')
    .insert({
      name,
      slug,
      email:            email            || null,
      tagline:          tagline          || null,
      instagram_handle: instagram_handle || null,
      website_url:      website_url      || null,
      primary_color:    primary_color    || null,
      accent_color:     accent_color     || null,
      logo_url:         logo_url         || null,
      currency_code:    currency_code    || 'INR',
      timezone:         timezone         || 'Asia/Kolkata',
      auth_user_id:     authUserId,
      is_active:        true,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  const { error: userError } = await supabase
    .from('baker_appusers')
    .insert({
      baker_id:        data.id,
      first_name:      primaryUser.first_name,
      last_name:       primaryUser.last_name,
      email:           primaryUser.email,
      phone:           primaryUser.phone || null,
      whatsapp_number: primaryUser.whatsapp_number || null,
      role:            'owner',
      is_primary:      true,
      auth_user_id:    authUserId,
    });
  if (userError) {
    await supabase.from('bakers').delete().eq('id', data.id);
    throw new Error(userError.message);
  }

  // Start baker on Spark (free, 30 days).
  const today    = new Date().toISOString().slice(0, 10);
  const sparkEnd = new Date();
  sparkEnd.setDate(sparkEnd.getDate() + 30);

  const { error: subErr } = await supabase.from('baker_subscriptions').insert({
    baker_id:          data.id,
    plan_id:           PLAN.SPARK,
    billing_period_id: PERIOD.MONTHLY,
    status:            'active',
    start_date:        today,
    end_date:          sparkEnd.toISOString().slice(0, 10),
  });
  if (subErr) console.error('baker_subscriptions insert failed:', subErr.message);

  await supabase.from('bakers').update({
    subscription_plan_id:   PLAN.SPARK,
    subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
  }).eq('id', data.id);

  await logSubscriptionEvent(data.id, {
    event: 'activated', newTier: 'spark', newStatus: 'active', changedBy: 'system',
  });

  return { id: data.id };
}
