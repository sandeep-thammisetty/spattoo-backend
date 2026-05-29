import { Router } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

const razorpay = new Razorpay({
  key_id:     config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

const PLANS = {
  starter: {
    name:    'Starter',
    monthly: config.razorpay.plans.starterMonthly,
    yearly:  config.razorpay.plans.starterYearly,
  },
  pro: {
    name:    'Pro',
    monthly: config.razorpay.plans.proMonthly,
    yearly:  config.razorpay.plans.proYearly,
  },
};

async function getBakerForUser(userId) {
  const { data: contact } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  if (!contact) return null;
  const { data: baker } = await supabase
    .from('bakers')
    .select('id, name, email, subscription_tier, subscription_status, trial_ends_at, billing_customer_id, billing_subscription_id')
    .eq('id', contact.baker_id).single();
  return baker;
}

// ── GET /billing/status ───────────────────────────────────────────────────────
router.get('/billing/status', requireAuth, async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id);
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    let nextBillingAt = null;
    if (baker.billing_subscription_id) {
      try {
        const sub = await razorpay.subscriptions.fetch(baker.billing_subscription_id);
        if (sub.charge_at) nextBillingAt = new Date(sub.charge_at * 1000).toISOString();
      } catch {}
    }

    res.json({
      tier:                     baker.subscription_tier,
      status:                   baker.subscription_status,
      trial_ends_at:            baker.trial_ends_at,
      billing_subscription_id: baker.billing_subscription_id,
      next_billing_at:          nextBillingAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/subscribe ───────────────────────────────────────────────────
// Creates a Razorpay subscription and returns the id + key for the frontend
// to open Razorpay Checkout.
router.post('/billing/subscribe', requireAuth, async (req, res) => {
  try {
    const { tier, period } = req.body;

    if (!PLANS[tier] || !['monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ error: 'Invalid tier or period' });
    }
    const planId = PLANS[tier][period];
    if (!planId) return res.status(400).json({ error: `Plan not configured: ${tier}/${period}` });

    const baker = await getBakerForUser(req.user.id);
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    // Get or create Razorpay customer
    let customerId = baker.billing_customer_id;
    if (!customerId) {
      const customer = await razorpay.customers.create({
        name:  baker.name,
        email: baker.email || undefined,
        fail_existing: 0,
      });
      customerId = customer.id;
      await supabase.from('bakers').update({ billing_customer_id: customerId }).eq('id', baker.id);
    }

    // Cancel any existing active subscription first
    if (baker.billing_subscription_id) {
      try {
        await razorpay.subscriptions.cancel(baker.billing_subscription_id, { cancel_at_cycle_end: 0 });
      } catch {}
    }

    const totalCount = period === 'yearly' ? 10 : 120; // 10 years or 120 months max
    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      customer_id:     customerId,
      customer_notify: 1,
      total_count:     totalCount,
      quantity:        1,
    });

    await supabase.from('bakers').update({
      billing_subscription_id: subscription.id,
      subscription_tier:        tier,
      subscription_status:      'pending',
    }).eq('id', baker.id);

    res.json({
      subscription_id: subscription.id,
      key_id:          config.razorpay.keyId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
// Cancels at end of current billing cycle.
router.post('/billing/cancel', requireAuth, async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id);
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    if (!baker.billing_subscription_id) return res.status(400).json({ error: 'No active subscription' });

    await razorpay.subscriptions.cancel(baker.billing_subscription_id, { cancel_at_cycle_end: 1 });
    await supabase.from('bakers').update({ subscription_status: 'cancelled' }).eq('id', baker.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/webhook ─────────────────────────────────────────────────────
// Raw body required for signature verification — mounted with express.raw() in server.js.
router.post('/billing/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body; // Buffer when using express.raw()

    const expected = crypto
      .createHmac('sha256', config.razorpay.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expected) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody.toString());
    const { event } = payload;
    const sub = payload?.payload?.subscription?.entity;

    if (!sub?.id) return res.json({ ok: true });

    const { data: baker } = await supabase
      .from('bakers').select('id')
      .eq('billing_subscription_id', sub.id).maybeSingle();

    if (!baker) return res.json({ ok: true });

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
      await supabase.from('bakers').update({ subscription_status: newStatus }).eq('id', baker.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
