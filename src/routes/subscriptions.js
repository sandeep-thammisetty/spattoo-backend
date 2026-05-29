import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Shared helper ─────────────────────────────────────────────────────────────

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
      .select('id, name, slug, email, subscription_tier, subscription_status, trial_ends_at, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /admin/bakers/:id/subscription ────────────────────────────────────────
router.get('/admin/bakers/:id/subscription', requireAuth, async (req, res) => {
  try {
    const { data: baker, error } = await supabase
      .from('bakers')
      .select('id, name, email, subscription_tier, subscription_status, trial_ends_at, billing_subscription_id')
      .eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Baker not found' });

    const { data: events } = await supabase
      .from('subscription_events').select('*')
      .eq('baker_id', req.params.id)
      .order('created_at', { ascending: false }).limit(50);

    res.json({ baker, events: events ?? [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /admin/bakers/:id/subscription ───────────────────────────────────────
// Admin override — manually set tier, status, trial end date
router.post('/admin/bakers/:id/subscription', requireAuth, async (req, res) => {
  try {
    const { tier, status, trial_ends_at, note } = req.body;

    const { data: existing } = await supabase
      .from('bakers').select('id, subscription_tier, subscription_status')
      .eq('id', req.params.id).single();
    if (!existing) return res.status(404).json({ error: 'Baker not found' });

    const updates = {};
    if (tier)                        updates.subscription_tier   = tier;
    if (status)                      updates.subscription_status = status;
    if (trial_ends_at !== undefined) updates.trial_ends_at       = trial_ends_at || null;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    const { error } = await supabase.from('bakers').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    await logSubscriptionEvent(req.params.id, {
      event:          'admin_override',
      previousTier:   existing.subscription_tier,
      newTier:        tier    ?? existing.subscription_tier,
      previousStatus: existing.subscription_status,
      newStatus:      status  ?? existing.subscription_status,
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
