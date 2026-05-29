import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Shared helpers ─────────────────────────────────────────────────────────────

export async function logSubscriptionEvent(bakerId, {
  event, previousTier, newTier, previousStatus, newStatus, note, changedBy, changedById,
}) {
  const { error } = await supabase.from('subscription_events').insert({
    baker_id:        bakerId,
    event,
    previous_tier:   previousTier  ?? null,
    new_tier:        newTier       ?? null,
    previous_status: previousStatus ?? null,
    new_status:      newStatus      ?? null,
    note:            note           ?? null,
    changed_by:      changedBy      ?? 'system',
    changed_by_id:   changedById    ?? null,
  });
  if (error) console.error('logSubscriptionEvent failed:', error.message);
}

// Returns the baker's current subscription with derived status.
// Status is derived: if end_date is in the past and status is 'active' → 'expired'.
export async function deriveSubscription(bakerId) {
  const { data } = await supabase
    .from('baker_subscriptions')
    .select(`
      id, status, end_date, start_date, billing_subscription_id,
      subscription_plans ( id, name, display_name ),
      billing_periods    ( name, display_name )
    `)
    .eq('baker_id', bakerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { status: 'no_subscription', plan: null, end_date: null, id: null };

  const isExpired = data.end_date && new Date(data.end_date) < new Date();
  const status    = isExpired && data.status === 'active' ? 'expired' : data.status;

  return {
    id:         data.id,
    status,
    plan:       data.subscription_plans ?? null,
    period:     data.billing_periods    ?? null,
    end_date:   data.end_date,
    start_date: data.start_date,
    billing_subscription_id: data.billing_subscription_id,
  };
}

// ── GET /admin/subscription-plans ─────────────────────────────────────────────
router.get('/admin/subscription-plans', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscription_plans').select('*').order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/subscription-plans ────────────────────────────────────────────
router.post('/admin/subscription-plans', requireAuth, async (req, res) => {
  try {
    const { name, display_name, price_monthly, price_yearly, features, sort_order } = req.body;
    if (!name || !display_name) return res.status(400).json({ error: 'name and display_name are required' });

    const { data, error } = await supabase
      .from('subscription_plans')
      .insert({ name, display_name, price_monthly: price_monthly ?? 0, price_yearly: price_yearly ?? 0, features: features ?? {}, sort_order: sort_order ?? 0 })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /admin/subscription-plans/:id ───────────────────────────────────────
router.patch('/admin/subscription-plans/:id', requireAuth, async (req, res) => {
  try {
    const ALLOWED = ['display_name', 'price_monthly', 'price_yearly', 'features', 'is_active', 'sort_order'];
    const updates = {};
    for (const f of ALLOWED) { if (f in req.body) updates[f] = req.body[f]; }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    const { data, error } = await supabase
      .from('subscription_plans').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /admin/bakers/subscriptions ───────────────────────────────────────────
router.get('/admin/bakers/subscriptions', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bakers')
      .select(`
        id, name, slug, email, created_at,
        baker_subscriptions (
          id, status, end_date, created_at,
          subscription_plans ( name, display_name )
        )
      `)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const today = new Date();
    const result = (data ?? []).map(b => {
      const latest = (b.baker_subscriptions ?? [])
        .sort((a, z) => new Date(z.created_at) - new Date(a.created_at))[0] ?? null;
      const isExpired = latest?.end_date && new Date(latest.end_date) < today;
      const status = latest
        ? (isExpired && latest.status === 'active' ? 'expired' : latest.status)
        : 'no_subscription';
      return {
        id: b.id, name: b.name, slug: b.slug, email: b.email, created_at: b.created_at,
        subscription_plan:   latest?.subscription_plans?.name ?? null,
        subscription_status: status,
        end_date:            latest?.end_date ?? null,
      };
    });

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /admin/bakers/:id/subscription ────────────────────────────────────────
router.get('/admin/bakers/:id/subscription', requireAuth, async (req, res) => {
  try {
    const { data: baker, error } = await supabase
      .from('bakers').select('id, name, email')
      .eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Baker not found' });

    const current = await deriveSubscription(req.params.id);

    const { data: events } = await supabase
      .from('subscription_events').select('*')
      .eq('baker_id', req.params.id)
      .order('created_at', { ascending: false }).limit(50);

    res.json({ baker, current, events: events ?? [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/bakers/:id/subscription ───────────────────────────────────────
// Admin override — create a new baker_subscriptions row with the given plan/status/end date
router.post('/admin/bakers/:id/subscription', requireAuth, async (req, res) => {
  try {
    const { plan_name, status, end_date, note } = req.body;
    if (!plan_name) return res.status(400).json({ error: 'plan_name is required' });

    const { data: plan } = await supabase
      .from('subscription_plans').select('id, name').eq('name', plan_name).maybeSingle();
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${plan_name}` });

    const current = await deriveSubscription(req.params.id);
    const today   = new Date().toISOString().slice(0, 10);

    // Close the current active subscription row
    if (current.id) {
      await supabase.from('baker_subscriptions')
        .update({ status: 'cancelled', end_date: today })
        .eq('id', current.id);
    }

    // Create the new row
    await supabase.from('baker_subscriptions').insert({
      baker_id:   req.params.id,
      plan_id:    plan.id,
      status:     status ?? 'active',
      start_date: today,
      end_date:   end_date || null,
    });

    // Keep subscription_plan_id in sync
    await supabase.from('bakers')
      .update({ subscription_plan_id: plan.id })
      .eq('id', req.params.id);

    await logSubscriptionEvent(req.params.id, {
      event:          'admin_override',
      previousTier:   current.plan?.name  ?? null,
      newTier:        plan.name,
      previousStatus: current.status,
      newStatus:      status ?? 'active',
      note,
      changedBy:      'admin',
      changedById:    req.user.id,
    });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /baker/subscription/history ───────────────────────────────────────────
router.get('/baker/subscription/history', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account' });

    const { data, error } = await supabase
      .from('subscription_events')
      .select('id, event, previous_tier, new_tier, previous_status, new_status, note, created_at')
      .eq('baker_id', contact.baker_id)
      .order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
