import { supabase } from './supabase.js';
import { logSubscriptionEvent } from '../routes/subscriptions.js';
import { getSparkTrialDays }    from './entitlements.js';
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

// Short, unambiguous random token (no 0/o/1/l) used to de-dupe slugs.
function randomSuffix(n = 4) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Derive a UNIQUE storefront slug from the bakery name — server-side, never
// user-chosen, so a baker can't squat another baker's name. The name-derived base
// is the stable part; if it's reserved/taken we append a random suffix (e.g.
// "sweet-cakes" → "sweet-cakes-7k2"). Later, settings will let the owner edit only
// that suffix, never the base.
export async function generateUniqueSlug(name) {
  // Cap the base so base + "-xxxx" still fits the 40-char slug limit.
  let base = normalizeSlug(name).slice(0, 30).replace(/-+$/g, '');
  if (base.length < 3) base = `brand-${randomSuffix()}`;

  let candidate = base;
  for (let i = 0; i < 25; i++) {
    if (isValidSlug(candidate) && !RESERVED_SLUGS.has(candidate) && !(await slugTaken(candidate))) {
      return candidate;
    }
    candidate = `${base}-${randomSuffix()}`.slice(0, 40).replace(/-+$/g, '');
  }
  // Extremely unlikely fallback after 25 collisions.
  return `brand-${randomSuffix(6)}`;
}

// Create the baker's DB rows for an ALREADY-EXISTING auth user (caller owns the
// Supabase Auth user lifecycle): `bakers` + `baker_appusers` (owner/primary) + a
// Spark (free, 30-day) `baker_subscriptions` row + the subscription event, and mirror
// plan/status onto the baker. Rolls back the baker (and its primary appuser) if the
// appuser OR subscription insert fails; does NOT touch Supabase Auth. Throws on failure.
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
  // Idempotent: a user owns AT MOST ONE baker (enforced by the unique index on
  // bakers.auth_user_id — migration 012). If they already have one, return it
  // rather than creating a duplicate. Safe for both callers: self-signup may
  // retry, and admin onboarding always passes a freshly-created auth user (no
  // existing baker), so this never short-circuits a genuine new baker.
  const { data: existing } = await supabase
    .from('bakers')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (existing) return { id: existing.id, alreadyExisted: true };

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

  // Start baker on Spark — one-time, time-boxed trial; length configurable (features.trial_days).
  const today     = new Date().toISOString().slice(0, 10);
  const trialDays = await getSparkTrialDays();
  const sparkEnd  = new Date();
  sparkEnd.setDate(sparkEnd.getDate() + trialDays);

  const { error: subErr } = await supabase.from('baker_subscriptions').insert({
    baker_id:          data.id,
    plan_id:           PLAN.SPARK,
    billing_period_id: PERIOD.MONTHLY,
    status_id:         SUBSCRIPTION_STATUS.ACTIVE,  // table uses status_id (text `status` column was dropped)
    start_date:        today,
    end_date:          sparkEnd.toISOString().slice(0, 10),
  });
  if (subErr) {
    // A baker must never exist without a subscription (it drives entitlements +
    // expiry). Roll back the baker and its primary appuser, and fail loudly —
    // rather than silently leaving an unsubscribed baker (the bug this replaces).
    await supabase.from('baker_appusers').delete().eq('baker_id', data.id);
    await supabase.from('bakers').delete().eq('id', data.id);
    throw new Error(`baker_subscriptions insert failed: ${subErr.message}`);
  }

  await supabase.from('bakers').update({
    subscription_plan_id:   PLAN.SPARK,
    subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
  }).eq('id', data.id);

  await logSubscriptionEvent(data.id, {
    event: 'activated', newTier: 'spark', newStatus: 'active', changedBy: 'system',
  });

  return { id: data.id };
}
