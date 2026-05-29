import { Router } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';

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
  const { data: contact } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  if (!contact) return null;
  const { data: baker } = await supabase
    .from('bakers').select(fields).eq('id', contact.baker_id).single();
  return baker;
}

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

    // Fetch billing period from DB
    const { data: period, error: periodErr } = await supabase
      .from('billing_periods')
      .select('id, name, months, display_name')
      .eq('id', billing_period_id)
      .eq('is_active', true)
      .single();
    if (periodErr || !period) return res.status(400).json({ error: 'Invalid billing period' });

    // Look up Razorpay plan ID dynamically
    const razorpayPlanId = getRazorpayPlanId(tier, period.name);
    if (!razorpayPlanId) {
      return res.status(400).json({ error: `Razorpay plan not configured for ${tier}/${period.name}` });
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

    // total_count = ~10 years worth of cycles
    const totalCount = Math.ceil(120 / period.months);
    const subscription = await getRazorpay().subscriptions.create({
      plan_id: razorpayPlanId, customer_id: customerId,
      customer_notify: 1, total_count: totalCount, quantity: 1,
    });

    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + period.months);

    // Fetch plan row for plan_id
    const { data: plan } = await supabase
      .from('subscription_plans').select('id').eq('name', tier).maybeSingle();

    // Close any previous active subscription row
    await supabase.from('baker_subscriptions')
      .update({ status: 'cancelled', end_date: today })
      .eq('baker_id', baker.id).eq('status', 'active');

    // Create new subscription row (pending until webhook confirms)
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           plan?.id ?? null,
      billing_period_id: period.id,
      status:            'pending',
      start_date:        today,
      end_date:          endDate.toISOString().slice(0, 10),
      billing_subscription_id: subscription.id,
    });

    await supabase.from('bakers').update({
      billing_subscription_id: subscription.id,
      subscription_plan_id:    plan?.id ?? null,
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

    // subscription_status is derived from baker_subscriptions — no bakers update needed

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

    const { data: plan }   = await supabase.from('subscription_plans').select('id').eq('name', 'spark').maybeSingle();
    const { data: period } = await supabase.from('billing_periods').select('id').eq('name', 'spark').maybeSingle();
    const today = new Date().toISOString().slice(0, 10);

    // Close previous active subscription rows
    await supabase.from('baker_subscriptions')
      .update({ status: 'cancelled', end_date: today })
      .eq('baker_id', baker.id).eq('status', 'active');

    // Spark has no end date — it's free and ongoing
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           plan?.id ?? null,
      billing_period_id: period?.id ?? null,
      status:            'active',
      start_date:        today,
      end_date:          null,
    });

    await supabase.from('bakers').update({
      subscription_plan_id: plan?.id ?? null,
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
      'subscription.activated': 'active',
      'subscription.charged':   'active',
      'subscription.resumed':   'active',
      'subscription.paused':    'paused',
      'subscription.cancelled': 'cancelled',
      'subscription.completed': 'cancelled',
      'payment.failed':         'past_due',
    };

    const newStatus = STATUS_MAP[event];
    if (newStatus) {
      const today = new Date().toISOString().slice(0, 10);
      const update = { status: newStatus };
      if (['cancelled', 'paused'].includes(newStatus)) update.end_date = today;
      await supabase.from('baker_subscriptions').update(update).eq('id', subRow.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
