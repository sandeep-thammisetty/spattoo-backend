import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { PAYMENT_STATUS }      from '../constants/paymentStatuses.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';

const router = Router();

// ── Razorpay stubs ────────────────────────────────────────────────────────────
// TODO: replace each stub with the real Razorpay SDK call when integrating.
// SDK: https://github.com/razorpay/razorpay-node
// All methods should throw on failure so the caller's try/catch handles it.

// TODO: call razorpay.customers.create({ name, email, fail_existing: 0 })
//       store the returned customer.id in bakers.billing_customer_id
async function razorpayGetOrCreateCustomer(baker) {
  if (baker.billing_customer_id) return baker.billing_customer_id;
  return `cust_mock_${Date.now()}`;
}

// TODO: call razorpay.subscriptions.create({ plan_id, customer_id, customer_notify: 1, total_count, quantity: 1 })
//       plan_id comes from env RAZORPAY_PLAN_{TIER}_{PERIOD} (e.g. RAZORPAY_PLAN_FLAME_MONTHLY)
async function razorpayCreateSubscription(_planId, _customerId, _totalCount) {
  return { id: `sub_mock_${Date.now()}` };
}

// TODO: call razorpay.subscriptions.cancel(subscriptionId, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 })
async function razorpayCancelSubscription(_subscriptionId, _atCycleEnd) {
  return { ok: true };
}

// TODO: verify webhook signature using crypto.createHmac + config.razorpay.webhookSecret
//       throw if invalid so the webhook handler returns 400
function razorpayVerifyWebhook(_rawBody, _signature) {
  // const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(_rawBody).digest('hex');
  // if (_signature !== expected) throw new Error('Invalid signature');
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
      tier:            sub.plan?.name           ?? null,
      status:          sub.status,
      next_billing_at: sub.end_date             ?? null,
      billing_period:  sub.period?.display_name ?? null,
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

    const baker = await getBakerForUser(req.user.id, 'id, name, email, billing_customer_id, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const periodMonths = PERIOD.MONTHS_BY_ID[billing_period_id];
    const today        = new Date().toISOString().slice(0, 10);
    const endDate      = new Date();
    endDate.setMonth(endDate.getMonth() + periodMonths);

    const customerId = await razorpayGetOrCreateCustomer(baker);
    await supabase.from('bakers').update({ billing_customer_id: customerId }).eq('id', baker.id);

    if (baker.billing_subscription_id) {
      await razorpayCancelSubscription(baker.billing_subscription_id, false);
    }

    const totalCount   = Math.ceil(120 / periodMonths);
    const subscription = await razorpayCreateSubscription(`RAZORPAY_PLAN_${tier.toUpperCase()}_${periodName.toUpperCase()}`, customerId, totalCount);

    // Close any previous active/pending subscription row
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
      billing_subscription_id: subscription.id,
      subscription_plan_id:    planId,
      subscription_status_id:  SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    // TODO: when Razorpay is live, return { subscription_id, key_id } and open
    //       the Razorpay checkout on the frontend instead of activating immediately.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
router.post('/billing/cancel', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    await razorpayCancelSubscription(baker.billing_subscription_id, true);

    // Only flip the baker status — baker_subscriptions stays active until the cycle ends.
    // A daily job handles expiring baker_subscriptions rows once end_date has passed.
    // TODO: when Razorpay is live, the subscription.cancelled webhook will also update baker_subscriptions.
    await supabase.from('bakers')
      .update({ subscription_status_id: SUBSCRIPTION_STATUS.CANCELLED })
      .eq('id', baker.id);

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

    const today = new Date().toISOString().slice(0, 10);

    await supabase.from('baker_subscriptions')
      .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
      .eq('baker_id', baker.id).in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);

    // Spark is free with no end date
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           PLAN.SPARK,
      billing_period_id: PERIOD.MONTHLY,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          null,
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

// ── GET /billing/payments ─────────────────────────────────────────────────────
router.get('/billing/payments', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const { data, error } = await supabase
      .from('payments')
      .select('id, razorpay_payment_id, amount, currency, status_id, charged_at')
      .eq('baker_id', baker.id)
      .order('charged_at', { ascending: false })
      .limit(24);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
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

    const { data: bakerRow } = await supabase
      .from('bakers').select('id')
      .eq('billing_subscription_id', razorpaySubId).maybeSingle();
    if (!bakerRow) return res.json({ ok: true });

    const { data: subRow } = await supabase
      .from('baker_subscriptions').select('id')
      .eq('baker_id', bakerRow.id).not('status_id', 'eq', SUBSCRIPTION_STATUS.CANCELLED)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!subRow) return res.json({ ok: true });

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
      await supabase.from('baker_subscriptions').update(subUpdate).eq('id', subRow.id);
      await supabase.from('bakers')
        .update({ subscription_status_id: newStatusId })
        .eq('id', bakerRow.id);
    }

    if (payment?.id && (event === 'subscription.charged' || event === 'payment.failed')) {
      const paymentStatusId = event === 'subscription.charged' ? PAYMENT_STATUS.CAPTURED : PAYMENT_STATUS.FAILED;
      await supabase.from('payments').upsert({
        baker_id:                 bakerRow.id,
        baker_subscription_id:    subRow?.id ?? null,
        razorpay_payment_id:      payment.id,
        razorpay_subscription_id: razorpaySubId,
        amount:                   payment.amount ?? 0,
        currency:                 payment.currency ?? 'INR',
        status_id:                paymentStatusId,
        charged_at:               payment.created_at
          ? new Date(payment.created_at * 1000).toISOString()
          : new Date().toISOString(),
      }, { onConflict: 'razorpay_payment_id', ignoreDuplicates: true });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
