import { Router } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';

const router = Router();

// Lazily initialised — prevents startup crash when env vars not yet configured.
let _razorpay = null;
function getRazorpay() {
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }
  if (!_razorpay) {
    _razorpay = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  }
  return _razorpay;
}

// Dynamic plan ID lookup — no code changes needed when adding tiers or periods.
// Convention: RAZORPAY_PLAN_{TIER}_{PERIOD} e.g. RAZORPAY_PLAN_FLAME_QUARTERLY
function getRazorpayPlanId(tier, periodName) {
  const key = `RAZORPAY_PLAN_${tier.toUpperCase()}_${periodName.toUpperCase()}`;
  return process.env[key] ?? null;
}

async function getBakerForUser(userId, fields = 'id, name, email, subscription_tier, subscription_status, trial_ends_at') {
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
    .from('bakers').select('id, subscription_status, billing_subscription_id').eq('id', contact.baker_id).single();
  res.json({ user_id: req.user.id, baker_id: contact.baker_id, baker, baker_error: bErr?.message ?? null });
});

// ── GET /billing/periods ──────────────────────────────────────────────────────
router.get('/billing/periods', requireAuth, async (req, res) => {
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
router.get('/billing/status', requireAuth, async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const sub = await deriveSubscription(baker.id);

    res.json({
      tier:            sub.plan?.name        ?? null,
      status:          sub.status,
      next_billing_at: sub.end_date          ?? null,
      billing_period:  sub.period?.display_name ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/subscribe ───────────────────────────────────────────────────
router.post('/billing/subscribe', requireAuth, async (req, res) => {
  try {
    const { tier, billing_period_id } = req.body;
    if (!tier || !billing_period_id) {
      return res.status(400).json({ error: 'tier and billing_period_id are required' });
    }

    const periodName = PERIOD.NAME_BY_ID[billing_period_id];
    if (!periodName) return res.status(400).json({ error: 'Invalid billing period' });
    const planId = PLAN.ID_BY_NAME[tier];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${tier}` });

    // Look up Razorpay plan ID dynamically
    const razorpayPlanId = getRazorpayPlanId(tier, periodName);
    if (!razorpayPlanId) {
      return res.status(400).json({ error: `Razorpay plan not configured for ${tier}/${periodName}` });
    }

    const baker = await getBakerForUser(req.user.id,
      'id, name, email, subscription_tier, subscription_status, billing_customer_id, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    // Get or create Razorpay customer
    let customerId = baker.billing_customer_id;
    if (!customerId) {
      const customer = await getRazorpay().customers.create({
        name: baker.name, email: baker.email || undefined, fail_existing: 0,
      });
      customerId = customer.id;
      await supabase.from('bakers').update({ billing_customer_id: customerId }).eq('id', baker.id);
    }

    // Cancel existing active Razorpay subscription if any
    if (baker.billing_subscription_id) {
      try {
        await getRazorpay().subscriptions.cancel(baker.billing_subscription_id, { cancel_at_cycle_end: 0 });
      } catch {}
    }

    const periodMonths = PERIOD.MONTHS_BY_ID[billing_period_id];
    const totalCount   = Math.ceil(120 / periodMonths);
    const subscription = await getRazorpay().subscriptions.create({
      plan_id: razorpayPlanId, customer_id: customerId,
      customer_notify: 1, total_count: totalCount, quantity: 1,
    });

    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + periodMonths);

    // Close any previous active subscription row
    await supabase.from('baker_subscriptions')
      .update({ status: 'cancelled', end_date: today })
      .eq('baker_id', baker.id).eq('status', 'active');

    // Create new subscription row (pending until webhook confirms)
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           planId,
      billing_period_id: billing_period_id,
      status:            'pending',
      start_date:        today,
      end_date:          endDate.toISOString().slice(0, 10),
      billing_subscription_id: subscription.id,
    });

    await supabase.from('bakers').update({
      billing_subscription_id: subscription.id,
      subscription_plan_id:    planId,
      subscription_status_id:  SUBSCRIPTION_STATUS.PENDING,
    }).eq('id', baker.id);

    res.json({ subscription_id: subscription.id, key_id: config.razorpay.keyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
router.post('/billing/cancel', requireAuth, async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, subscription_status, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    if (!baker.billing_subscription_id) return res.status(400).json({ error: 'No active subscription' });

    await getRazorpay().subscriptions.cancel(baker.billing_subscription_id, { cancel_at_cycle_end: 1 });

    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('baker_subscriptions')
      .update({ status: 'cancelled', end_date: today })
      .eq('baker_id', baker.id).eq('status', 'active');

    // Flip immediately so the next billing cycle doesn't charge
    await supabase.from('bakers')
      .update({ subscription_status_id: SUBSCRIPTION_STATUS.CANCELLED })
      .eq('id', baker.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/activate-spark ─────────────────────────────────────────────
router.post('/billing/activate-spark', requireAuth, async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, subscription_tier, subscription_status');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    if (baker.subscription_status === 'active' && baker.subscription_tier !== 'trial') {
      return res.status(400).json({ error: 'Already on an active plan' });
    }

    const today = new Date().toISOString().slice(0, 10);

    // Close previous active subscription rows
    await supabase.from('baker_subscriptions')
      .update({ status: 'cancelled', end_date: today })
      .eq('baker_id', baker.id).eq('status', 'active');

    // Spark has no end date — it's free and ongoing
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           PLAN.SPARK,
      billing_period_id: PERIOD.MONTHLY,
      status:            'active',
      start_date:        today,
      end_date:          null,
    });

    await supabase.from('bakers').update({
      subscription_plan_id:   PLAN.SPARK,
      subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    await logSubscriptionEvent(baker.id, {
      event: 'activated', previousTier: baker.subscription_tier, newTier: 'spark',
      previousStatus: baker.subscription_status, newStatus: 'active', changedBy: 'baker',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/webhook ─────────────────────────────────────────────────────
router.post('/billing/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body;

    const expected = crypto
      .createHmac('sha256', config.razorpay.webhookSecret)
      .update(rawBody).digest('hex');

    if (signature !== expected) return res.status(400).json({ error: 'Invalid signature' });

    const payload = JSON.parse(rawBody.toString());
    const { event } = payload;
    const sub = payload?.payload?.subscription?.entity;
    if (!sub?.id) return res.json({ ok: true });

    // Find the subscription row directly by billing_subscription_id
    const { data: subRow } = await supabase
      .from('baker_subscriptions').select('id, baker_id')
      .eq('billing_subscription_id', sub.id).maybeSingle();
    if (!subRow) return res.json({ ok: true });

    const STATUS_MAP = {
      'subscription.activated': { status: 'active',    statusId: SUBSCRIPTION_STATUS.ACTIVE    },
      'subscription.charged':   { status: 'active',    statusId: SUBSCRIPTION_STATUS.ACTIVE    },
      'subscription.resumed':   { status: 'active',    statusId: SUBSCRIPTION_STATUS.ACTIVE    },
      'subscription.paused':    { status: 'paused',    statusId: SUBSCRIPTION_STATUS.PAUSED    },
      'subscription.cancelled': { status: 'cancelled', statusId: SUBSCRIPTION_STATUS.CANCELLED },
      'subscription.completed': { status: 'cancelled', statusId: SUBSCRIPTION_STATUS.CANCELLED },
      'payment.failed':         { status: 'past_due',  statusId: SUBSCRIPTION_STATUS.PAST_DUE  },
    };

    const mapped = STATUS_MAP[event];
    if (mapped) {
      const today = new Date().toISOString().slice(0, 10);
      const subUpdate = { status: mapped.status };
      if (['cancelled', 'paused'].includes(mapped.status)) subUpdate.end_date = today;
      await supabase.from('baker_subscriptions').update(subUpdate).eq('id', subRow.id);
      await supabase.from('bakers')
        .update({ subscription_status_id: mapped.statusId })
        .eq('id', subRow.baker_id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
