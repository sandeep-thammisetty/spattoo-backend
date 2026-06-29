import { supabase } from './supabase.js';
import { deriveSubscription } from '../routes/subscriptions.js';
import { ENTITLEMENTS, BLOCKED_STATUSES } from '../constants/entitlements.js';

// Per-plan entitlement values live on the plan row (admin-editable, seeded once).
// Read per call — plans are a 4-row lookup and this runs once per request.
async function getPlanFeatures(planId) {
  if (!planId) return {};
  const { data } = await supabase
    .from('subscription_plans').select('features').eq('id', planId).maybeSingle();
  return (data?.features && typeof data.features === 'object') ? data.features : {};
}

// Resolve a baker's entitlements: subscription status (the gate) + the per-key
// values from their plan, with an INACTIVE subscription collapsing everything to
// its fallback. The single source of truth both the middleware and the client read.
export async function getEntitlements(bakerId) {
  const sub      = await deriveSubscription(bakerId);
  const status   = sub?.status ?? 'no_subscription';
  const blocked  = BLOCKED_STATUSES.has(status);
  const features = blocked ? {} : await getPlanFeatures(sub?.plan?.id);

  const ent = {};
  for (const [key, def] of Object.entries(ENTITLEMENTS)) {
    // `key in features` (not ??) so an explicit null (= unlimited) is preserved
    // instead of falling back to the floor.
    const raw = Object.prototype.hasOwnProperty.call(features, key) ? features[key] : def.fallback;
    ent[key] = blocked ? def.fallback : raw;
  }

  return {
    planId: sub?.plan?.id ?? null,
    plan:   sub?.plan?.name ?? null,   // display/telemetry only — never gate on this
    status,
    active: !blocked,
    ent,
  };
}
