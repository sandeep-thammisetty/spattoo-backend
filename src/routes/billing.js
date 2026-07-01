import { Router } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { getSparkTrialDays } from '../services/entitlements.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { PAYMENT_STATUS }      from '../constants/paymentStatuses.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';

const router = Router();

// ── Razorpay client + helpers ───────────────────────────────────────────────────
// Lazily construct the SDK so local/dev boot never fails without keys; the helpers
// throw a clear error at call time when Razorpay isn't configured. `razorpayEnabled`
// lets the subscribe route fall back to immediate (no-charge) activation in envs
// without keys, while configured envs go through real Checkout.
function razorpayEnabled() {
  return !!(config.razorpay.keyId && config.razorpay.keySecret);
}
let _razorpay = null;
function razorpay() {
  if (!razorpayEnabled()) throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  if (!_razorpay) _razorpay = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  return _razorpay;
}

// Create a Razorpay subscription for a plan. The CUSTOMER is captured at Checkout
// (subscriptions.create takes NO customer_id) — we return the subscription id, which
// the frontend hands to Razorpay Checkout for authorisation. total_count = number of
// billing cycles before it auto-completes.
async function razorpayCreateSubscription(planId, totalCount, notes) {
  const sub = await razorpay().subscriptions.create({
    plan_id:         planId,
    total_count:     totalCount,
    quantity:        1,
    customer_notify: 1,
    notes:           notes ?? {},
  });
  return { id: sub.id };
}

// Cancel a Razorpay subscription. atCycleEnd=true keeps access until the cycle ends;
// false cancels immediately (used when switching plans).
async function razorpayCancelSubscription(subscriptionId, atCycleEnd) {
  if (!subscriptionId) return { ok: true };
  await razorpay().subscriptions.cancel(subscriptionId, !!atCycleEnd);
  return { ok: true };
}

// Verify a webhook is genuinely from Razorpay: HMAC-SHA256 of the RAW body with the
// webhook secret must equal the X-Razorpay-Signature header. Throws if not (timing-safe).
function razorpayVerifyWebhook(rawBody, signature) {
  const secret = config.razorpay.webhookSecret;
  if (!secret) throw new Error('Razorpay webhook secret not configured');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature ?? ''), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid webhook signature');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getBakerForUser(userId, fields = 'id, name, email, trial_ends_at') {
  const { data: contact, error: contactErr } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  if (contactErr) console.error('getBakerForUser: baker_appusers lookup failed:', contactErr.message, '| userId:', userId);
  if (!contact)   console.error('getBakerForUser: no baker_appusers row for userId:', userId);
  if (!contact) return null;
  const { data: baker, error: bakerErr } = await supabase
    .from('bakers').select(fields).eq('id', contact.baker_id).single();
  if (bakerErr) console.error('getBakerForUser: bakers lookup failed:', bakerErr.message, '| fields:', fields, '| baker_id:', contact.baker_id);
  return baker ?? null;
}

// ── GET /billing/ping (debug) ─────────────────────────────────────────────────
router.get('/billing/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── GET /billing/debug-me (debug) ────────────────────────────────────────────
router.get('/billing/debug-me', requireAuth, async (req, res) => {
  const { data: contact, error: cErr } = await supabase
    .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
  if (cErr || !contact) return res.json({ user_id: req.user.id, contact: null, contact_error: cErr?.message ?? 'no row' });
  const { data: baker, error: bErr } = await supabase
    .from('bakers').select('id, subscription_status_id, billing_subscription_id').eq('id', contact.baker_id).single();
  res.json({ user_id: req.user.id, baker_id: contact.baker_id, baker, baker_error: bErr?.message ?? null });
});

// ── GET /billing/periods ──────────────────────────────────────────────────────
router.get('/billing/periods', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('billing_periods')
      .select('id, name, display_name, months, discount_pct')
      .eq('is_active', true)
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /billing/status ───────────────────────────────────────────────────────
router.get('/billing/status', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const sub = await deriveSubscription(baker.id);

    res.json({
      tier:                 sub.plan?.name           ?? null,
      status:               sub.status,
      next_billing_at:      sub.end_date             ?? null,
      billing_period:       sub.period?.display_name ?? null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/subscribe ───────────────────────────────────────────────────
router.post('/billing/subscribe', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { tier, billing_period_id } = req.body;
    if (!tier || !billing_period_id) {
      return res.status(400).json({ error: 'tier and billing_period_id are required' });
    }

    const periodName = PERIOD.NAME_BY_ID[billing_period_id];
    if (!periodName) return res.status(400).json({ error: 'Invalid billing period' });
    const planId = PLAN.ID_BY_NAME[tier];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${tier}` });

    const baker = await getBakerForUser(req.user.id, 'id, name, email, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const periodMonths = PERIOD.MONTHS_BY_ID[billing_period_id];
    const today        = new Date().toISOString().slice(0, 10);
    const totalCount   = Math.ceil(120 / periodMonths);   // ~10 years of cycles ("until cancelled")

    // ── Real Razorpay flow ────────────────────────────────────────────────────
    // Create the Razorpay subscription and hand the Checkout handle to the frontend.
    // We do NOT activate the baker here — activation happens on the subscription
    // webhook AFTER the customer authorises payment. A PENDING local row is parked
    // for the webhook to flip to active.
    if (razorpayEnabled()) {
      const razorpayPlanId = process.env[`RAZORPAY_PLAN_${tier.toUpperCase()}_${periodName.toUpperCase()}`];
      if (!razorpayPlanId) {
        return res.status(400).json({ error: `No Razorpay plan configured for ${tier} ${periodName}` });
      }

      // Cancel any in-flight Razorpay subscription before starting a new one.
      if (baker.billing_subscription_id) {
        await razorpayCancelSubscription(baker.billing_subscription_id, false)
          .catch(err => console.error('[billing] cancel previous Razorpay sub failed:', err.message));
      }

      const subscription = await razorpayCreateSubscription(razorpayPlanId, totalCount, { baker_id: baker.id, tier, period: periodName });

      // Close prior active/pending local rows; park a PENDING row for this attempt.
      await supabase.from('baker_subscriptions')
        .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
        .eq('baker_id', baker.id).in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);

      const { error: parkErr } = await supabase.from('baker_subscriptions').insert({
        baker_id:                baker.id,
        plan_id:                 planId,
        billing_period_id:       billing_period_id,
        status_id:               SUBSCRIPTION_STATUS.PENDING,
        start_date:              today,
        end_date:                null,
        billing_subscription_id: subscription.id,
      });
      // Don't fail silently — if the pending row didn't land, the webhook has nothing to
      // activate. Roll back the just-created Razorpay subscription so it doesn't linger as
      // an orphaned active sub (which would keep billing with no local record), then surface.
      if (parkErr) {
        console.error('[billing] park PENDING subscription row failed:', parkErr.message);
        await razorpayCancelSubscription(subscription.id, false)
          .catch(e => console.error('[billing] rollback of orphaned Razorpay sub failed:', e.message));
        return res.status(500).json({ error: `Could not start subscription: ${parkErr.message}` });
      }

      await supabase.from('bakers').update({
        billing_subscription_id: subscription.id,
        subscription_plan_id:    planId,
        subscription_status_id:  SUBSCRIPTION_STATUS.PENDING,
      }).eq('id', baker.id);

      // The activation audit event is logged by the webhook once payment authorises.
      return res.json({ key_id: config.razorpay.keyId, subscription_id: subscription.id });
    }

    // ── No-keys fallback (local/dev) ──────────────────────────────────────────
    // Activate immediately with no charge so billing is exercisable without keys.
    const current = await deriveSubscription(baker.id);   // prior plan/status for the audit event
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + periodMonths);

    await supabase.from('baker_subscriptions')
      .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
      .eq('baker_id', baker.id).in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);

    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           planId,
      billing_period_id: billing_period_id,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          endDate.toISOString().slice(0, 10),
    });

    await supabase.from('bakers').update({
      subscription_plan_id:   planId,
      subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    // Plan IDs are the tier rank (spark<flame<blaze<forge) → direction from the id compare.
    const prevPlanId = current.plan ? PLAN.ID_BY_NAME[current.plan.name] : null;
    const event = (current.status !== 'active' || prevPlanId == null) ? 'activated'
      : planId > prevPlanId ? 'upgraded'
      : planId < prevPlanId ? 'downgraded'
      : 'activated';
    await logSubscriptionEvent(baker.id, {
      event, previousTier: current.plan?.name ?? null, newTier: tier,
      previousStatus: current.status, newStatus: 'active', changedBy: 'baker',
    });

    res.json({ ok: true, mock: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
router.post('/billing/cancel', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const current = await deriveSubscription(baker.id);

    // Cancel at cycle end in Razorpay (keeps access until paid-through). AUTHORITATIVE:
    // if Razorpay rejects it, we must NOT report success — otherwise the baker thinks
    // they cancelled while Razorpay keeps charging. Surface the failure.
    if (razorpayEnabled() && baker.billing_subscription_id) {
      try {
        await razorpayCancelSubscription(baker.billing_subscription_id, true);
      } catch (err) {
        console.error('[billing] Razorpay cancel failed:', err.message);
        return res.status(502).json({
          error: 'Could not cancel with the payment provider. Please try again.',
          code:  'razorpay_cancel_failed',
        });
      }
    }

    // Mark the CURRENT subscription row to end at period end — keep access (status stays
    // active) until end_date; the subscription.cancelled webhook / daily expiry job flips
    // it to cancelled at the cycle end. The billing UI reads cancel_at_period_end to show
    // "won't renew" and hide the Cancel button. (baker_subscriptions is the source of
    // truth; bakers.subscription_status_id is mirrored by the webhook at cycle end.)
    const markQuery = supabase.from('baker_subscriptions').update({ cancel_at_period_end: true });
    const { error: markErr } = baker.billing_subscription_id
      ? await markQuery.eq('billing_subscription_id', baker.billing_subscription_id)
      : await markQuery.eq('baker_id', baker.id).eq('status_id', SUBSCRIPTION_STATUS.ACTIVE);
    if (markErr) return res.status(500).json({ error: markErr.message });

    await logSubscriptionEvent(baker.id, {
      event:          'cancelled',
      previousTier:   current.plan?.name ?? null,
      newTier:        current.plan?.name ?? null,
      previousStatus: current.status,
      newStatus:      'cancelled',
      changedBy:      'baker',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/activate-spark ─────────────────────────────────────────────
router.post('/billing/activate-spark', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, subscription_status_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    if (baker.subscription_status_id === SUBSCRIPTION_STATUS.ACTIVE) {
      return res.status(400).json({ error: 'Already on an active plan' });
    }

    // Spark is ONE-TIME — granted once (at signup), never as a fallback after a paid sub
    // lapses. If this baker has ever had a Spark subscription, they must pick a paid plan.
    const { count: priorSpark } = await supabase.from('baker_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('baker_id', baker.id).eq('plan_id', PLAN.SPARK);
    if ((priorSpark ?? 0) > 0) {
      return res.status(409).json({
        error: 'Your Spark trial has already been used. Choose a paid plan to continue.',
        code:  'SPARK_ALREADY_USED',
      });
    }

    const today     = new Date().toISOString().slice(0, 10);
    const trialDays = await getSparkTrialDays();
    const sparkEnd  = new Date();
    sparkEnd.setDate(sparkEnd.getDate() + trialDays);

    await supabase.from('baker_subscriptions')
      .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
      .eq('baker_id', baker.id).in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);

    // Spark trial — time-boxed (NEVER permanent), one-time per baker.
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           PLAN.SPARK,
      billing_period_id: PERIOD.MONTHLY,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          sparkEnd.toISOString().slice(0, 10),
    });

    await supabase.from('bakers').update({
      subscription_plan_id:   PLAN.SPARK,
      subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    await logSubscriptionEvent(baker.id, {
      event: 'activated', newTier: 'spark', newStatus: 'active', changedBy: 'baker',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// payments.status_id is a compact surrogate; translate it to a readable key at the API
// boundary (PAYMENT_STATUS.NAME_BY_ID) so callers never deal in the magic int.
const MAX_PAYMENTS = 24;

// ── GET /billing/payments ─────────────────────────────────────────────────────
// The baker's own payment records, recent → older. `?limit` (1..24, default 24) lets
// the billing UI fetch only the latest row on first look and the full list on demand,
// so it never transfers rows nobody views. `total` is the baker's exact payment count
// (index-only) so the UI can show "View all (N)" without pulling every row.
router.get('/billing/payments', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || MAX_PAYMENTS, 1), MAX_PAYMENTS);

    const { data, error, count } = await supabase
      .from('payments')
      .select('id, razorpay_payment_id, amount, currency, status_id, charged_at', { count: 'exact' })
      .eq('baker_id', baker.id)
      .order('charged_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const payments = (data ?? []).map(({ status_id, ...p }) => ({
      ...p,
      status: PAYMENT_STATUS.NAME_BY_ID[status_id] ?? 'unknown',
    }));
    res.json({ payments, total: count ?? payments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/webhook ─────────────────────────────────────────────────────
// TODO: this will be called by Razorpay when subscription events occur.
//       Until Razorpay is live this endpoint won't be hit.
router.post('/billing/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body;

    razorpayVerifyWebhook(rawBody, signature);

    const payload = JSON.parse(rawBody.toString());
    const { event } = payload;
    const sub     = payload?.payload?.subscription?.entity;
    const payment = payload?.payload?.payment?.entity;

    const razorpaySubId = sub?.id ?? payment?.subscription_id ?? null;
    if (!razorpaySubId) return res.json({ ok: true });

    // Match the EXACT local row for this Razorpay subscription by its billing_subscription_id
    // — NOT "the baker's most-recent non-cancelled row", which let a late event for a
    // superseded sub mutate the wrong (current) row.
    const { data: subRow, error: subLookupErr } = await supabase
      .from('baker_subscriptions').select('id, baker_id, plan_id')
      .eq('billing_subscription_id', razorpaySubId).maybeSingle();
    if (subLookupErr) throw new Error(`sub lookup failed: ${subLookupErr.message}`);
    if (!subRow) return res.json({ ok: true });
    const bakerId = subRow.baker_id;

    // Only mirror status onto bakers when this IS the baker's current subscription, so a
    // stale event for an old sub can't clobber the live status.
    const { data: bakerRow } = await supabase
      .from('bakers').select('billing_subscription_id').eq('id', bakerId).maybeSingle();
    const isCurrent = bakerRow?.billing_subscription_id === razorpaySubId;

    const STATUS_MAP = {
      'subscription.activated': SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.charged':   SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.resumed':   SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.pending':   SUBSCRIPTION_STATUS.PAST_DUE,   // charge failed; Razorpay retrying (dunning)
      'subscription.paused':    SUBSCRIPTION_STATUS.PAUSED,
      'subscription.halted':    SUBSCRIPTION_STATUS.EXPIRED,    // retries exhausted — lapsed but RECOVERABLE (same row)
      'subscription.cancelled': SUBSCRIPTION_STATUS.CANCELLED,  // terminal (user/admin) — a return is a new subscription
      'subscription.completed': SUBSCRIPTION_STATUS.CANCELLED,
      'payment.failed':         SUBSCRIPTION_STATUS.PAST_DUE,
    };

    const newStatusId = STATUS_MAP[event];
    if (newStatusId !== undefined) {
      const today = new Date().toISOString().slice(0, 10);
      const subUpdate = { status_id: newStatusId };
      if ([SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAUSED].includes(newStatusId)) {
        subUpdate.end_date = today;
      }
      // On a successful (re)charge, advance the paid-through date to Razorpay's
      // current cycle end — otherwise a RENEWED sub still has last cycle's end_date
      // and derives as 'expired'. This is also the recovery path: a halted/expired
      // row (still non-cancelled) is reactivated here → status active + end_date
      // forward, on the SAME row.
      if (event === 'subscription.charged' && sub?.current_end) {
        subUpdate.end_date = new Date(sub.current_end * 1000).toISOString().slice(0, 10);
      }
      // Error-checked: a failed write throws → 500 → Razorpay retries (no silent loss).
      const { error: subUpdErr } = await supabase
        .from('baker_subscriptions').update(subUpdate).eq('id', subRow.id);
      if (subUpdErr) throw new Error(`baker_subscriptions update failed: ${subUpdErr.message}`);
      if (isCurrent) {
        const { error: bakerUpdErr } = await supabase.from('bakers')
          .update({ subscription_status_id: newStatusId }).eq('id', bakerId);
        if (bakerUpdErr) throw new Error(`bakers status update failed: ${bakerUpdErr.message}`);
      }
    }

    // First activation (customer authorised payment) → record it in the subscription
    // history. subscribe() doesn't log for the paid flow, so the audit event lives here.
    if (event === 'subscription.activated') {
      await logSubscriptionEvent(bakerId, {
        event:     'activated',
        newTier:   PLAN.NAME_BY_ID[subRow.plan_id] ?? null,
        newStatus: 'active',
        changedBy: 'razorpay',
      }).catch(err => console.error('[billing] activation event log failed:', err.message));
    }

    // Record the payment on activation AND charge (whichever carries the payment entity
    // first) — onConflict makes it idempotent, so no duplicate. No longer hinges solely on
    // subscription.charged arriving. Error-checked so a failed write can't vanish silently.
    const PAYMENT_EVENT_STATUS = {
      'subscription.activated': PAYMENT_STATUS.CAPTURED,
      'subscription.charged':   PAYMENT_STATUS.CAPTURED,
      'payment.failed':         PAYMENT_STATUS.FAILED,
    };
    if (payment?.id && PAYMENT_EVENT_STATUS[event] !== undefined) {
      const { error: payErr } = await supabase.from('payments').upsert({
        baker_id:                 bakerId,
        baker_subscription_id:    subRow.id,
        razorpay_payment_id:      payment.id,
        razorpay_subscription_id: razorpaySubId,
        amount:                   payment.amount ?? 0,
        currency:                 payment.currency ?? 'INR',
        status_id:                PAYMENT_EVENT_STATUS[event],
        charged_at:               payment.created_at
          ? new Date(payment.created_at * 1000).toISOString()
          : new Date().toISOString(),
      }, { onConflict: 'razorpay_payment_id', ignoreDuplicates: true });
      if (payErr) throw new Error(`payments upsert failed: ${payErr.message}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
