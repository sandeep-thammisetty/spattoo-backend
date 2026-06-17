import { Router } from 'express';
import { randomBytes } from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const router = Router();

router.post('/admin/bakers', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const {
      name, slug, email, tagline,
      instagram_handle, website_url,
      primary_color, accent_color, logo_url,
      currency_code, timezone,
      primaryUser,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }
    if (!primaryUser?.first_name || !primaryUser?.last_name || !primaryUser?.email) {
      return res.status(400).json({ error: 'primaryUser.first_name, last_name, and email are required' });
    }

    // Check slug uniqueness before creating the auth user
    const { data: existing } = await supabase
      .from('bakers')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Slug already taken' });

    const tempPassword = randomBytes(6).toString('hex') + 'Aa1!';

    // Auth account is created for the primary user, not the business contact
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         primaryUser.email,
      password:      tempPassword,
      email_confirm: true,
    });
    if (authError) return res.status(400).json({ error: authError.message });

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
        auth_user_id:     authData.user.id,
        is_active:        true,
      })
      .select('id')
      .single();

    if (error) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: error.message });
    }

    // Insert primary user into baker_appusers
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
        auth_user_id:    authData.user.id,
      });

    if (userError) {
      // Roll back: delete baker row and auth user
      await supabase.from('bakers').delete().eq('id', data.id);
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: userError.message });
    }

    // Start baker on Spark (free, 30 days)
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

    res.status(201).json({ id: data.id, tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/baker/profile', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('first_name, last_name, baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data: baker } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, primary_color, accent_color, instagram_handle, website_url, tagline')
      .eq('id', contact.baker_id)
      .single();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const sub = await deriveSubscription(contact.baker_id);

    // Auto-log expiry event when status flips to expired for the first time
    if (sub.status === 'expired') {
      const { count } = await supabase
        .from('subscription_events')
        .select('id', { count: 'exact', head: true })
        .eq('baker_id', baker.id).eq('event', 'expired');
      if (!count) {
        await logSubscriptionEvent(baker.id, {
          event: 'expired', previousStatus: 'active', newStatus: 'expired', changedBy: 'system',
        });
      }
    }

    res.json({
      baker: {
        id: baker.id, name: baker.name, slug: baker.slug,
        logo_url:         toPublicUrl(baker.logo_url),
        primary_color:    baker.primary_color,  accent_color: baker.accent_color,
        instagram_handle: baker.instagram_handle, website_url: baker.website_url,
        tagline:          baker.tagline,
        subscription_status: sub.status,
        subscription_plan:   sub.plan?.name ?? null,
        subscription_end:    sub.end_date   ?? null,
      },
      user: { firstName: contact.first_name, lastName: contact.last_name, email: req.user.email },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/baker/profile', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const ALLOWED = ['primary_color', 'accent_color', 'logo_url', 'instagram_handle', 'website_url', 'tagline'];
    const updates = {};
    for (const f of ALLOWED) {
      if (f in req.body) updates[f] = req.body[f] || null;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabase
      .from('bakers')
      .update(updates)
      .eq('id', contact.baker_id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/baker/settings', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data: baker } = await supabase
      .from('bakers')
      .select('settings')
      .eq('id', contact.baker_id)
      .single();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    res.json(baker.settings ?? {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/baker/settings', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { error } = await supabase
      .from('bakers')
      .update({ settings: req.body })
      .eq('id', contact.baker_id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/baker/flavours ───────────────────────────────────────────────────
// Auth. The global flavour master list, flagged with this baker's on/off state:
//   [{ id, name, description, excluded }]
// `excluded: true` means the baker has switched it off and it's hidden from their
// customers (mirrors the resolution in the public GET /api/flavours). Custom baker
// flavours are managed separately, not here.
router.get('/baker/flavours', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const [{ data: globals }, { data: exclusions }] = await Promise.all([
      supabase.from('flavours')
        .select('id, name, description, sort_order')
        .eq('is_active', true)
        .order('sort_order').order('name'),
      supabase.from('baker_flavour_exclusions')
        .select('flavour_id')
        .eq('baker_id', contact.baker_id),
    ]);

    const excluded = new Set((exclusions ?? []).map(e => e.flavour_id));
    res.json((globals ?? []).map(f => ({
      id: f.id, name: f.name, description: f.description, excluded: excluded.has(f.id),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/baker/flavours/exclusions ────────────────────────────────────────
// Auth + store:manage. Body: { excluded_flavour_ids: [uuid, ...] }
// Replaces this baker's exclusion set (clear, then insert the new set). Only ids that
// are real active global flavours are written, so the table can't accumulate junk.
router.put('/baker/flavours/exclusions', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const requested = Array.isArray(req.body?.excluded_flavour_ids) ? req.body.excluded_flavour_ids : null;
    if (!requested) return res.status(400).json({ error: 'excluded_flavour_ids must be an array' });

    // Keep only ids that are real active global flavours.
    const { data: globals } = await supabase.from('flavours').select('id').eq('is_active', true);
    const valid = new Set((globals ?? []).map(f => f.id));
    const ids = [...new Set(requested)].filter(id => valid.has(id));

    // Replace the set: clear this baker's exclusions, then insert the new ones.
    const { error: delErr } = await supabase
      .from('baker_flavour_exclusions').delete().eq('baker_id', contact.baker_id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (ids.length) {
      const rows = ids.map(flavour_id => ({ baker_id: contact.baker_id, flavour_id }));
      const { error: insErr } = await supabase.from('baker_flavour_exclusions').insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }

    res.json({ ok: true, excluded_count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/bakers', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bakers')
      .select('id, name, slug, email, subscription_status_id, is_active, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
