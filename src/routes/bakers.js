import { Router } from 'express';
import { randomBytes } from 'crypto';
import { supabase } from '../services/supabase.js';
import { deleteObject } from '../services/r2.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolveCustomer } from '../middleware/rbac.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { createBakerForUser, slugTaken, normalizeSlug, isValidSlug, RESERVED_SLUGS } from '../services/bakerProvisioning.js';

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
    if (await slugTaken(slug)) return res.status(409).json({ error: 'Slug already taken' });

    const tempPassword = randomBytes(6).toString('hex') + 'Aa1!';

    // Auth account is created for the primary user, not the business contact
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         primaryUser.email,
      password:      tempPassword,
      email_confirm: true,
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // Shared provisioning: bakers + baker_appusers + Spark subscription + event.
    try {
      const { id } = await createBakerForUser({
        authUserId: authData.user.id,
        name, slug, email, tagline, instagram_handle, website_url,
        primary_color, accent_color, logo_url, currency_code, timezone, primaryUser,
      });
      res.status(201).json({ id, tempPassword });
    } catch (e) {
      // Admin created the auth user here, so admin rolls it back on failure.
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: e.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/bakers/slug-available?slug= ──────────────────────────────────────
// Public: live availability check for the self-signup storefront-address field.
router.get('/bakers/slug-available', async (req, res) => {
  try {
    const slug = normalizeSlug(req.query.slug);
    if (!slug || !isValidSlug(slug)) return res.json({ slug, available: false, reason: 'invalid' });
    if (RESERVED_SLUGS.has(slug))    return res.json({ slug, available: false, reason: 'reserved' });
    if (await slugTaken(slug))       return res.json({ slug, available: false, reason: 'taken' });
    return res.json({ slug, available: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/bakers/self ─────────────────────────────────────────────────────
// Baker self-signup completion. Auth = the newly-signed-up user's JWT (NOT the
// service key / admin). Creates their baker on the free Spark tier. Idempotent:
// one baker per auth user — if they already have one, return it.
// Body: { name, firstName, lastName, slug?, phone? }
router.post('/bakers/self', requireAuth, async (req, res) => {
  try {
    const { data: existingUser } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (existingUser?.baker_id) return res.status(200).json({ id: existingUser.baker_id, existing: true });

    const name      = (req.body.name ?? '').trim();
    const firstName = (req.body.firstName ?? '').trim();
    const lastName  = (req.body.lastName ?? '').trim();
    const phone     = req.body.phone || null;
    const slug      = normalizeSlug(req.body.slug || name);

    if (!name)                  return res.status(400).json({ error: 'Business name is required' });
    if (!firstName || !lastName) return res.status(400).json({ error: 'Your first and last name are required' });
    if (!slug || !isValidSlug(slug)) return res.status(400).json({ error: 'Pick a valid storefront address (3–40 letters, numbers, hyphens)' });
    if (RESERVED_SLUGS.has(slug)) return res.status(409).json({ error: 'That storefront address is reserved' });
    if (await slugTaken(slug))    return res.status(409).json({ error: 'That storefront address is already taken' });

    const { id } = await createBakerForUser({
      authUserId: req.user.id,
      name, slug,
      primaryUser: { first_name: firstName, last_name: lastName, email: req.user.email, phone },
    });
    res.status(201).json({ id });
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
    if (!contact) {
      // A logged-in customer (invite-gated): return their baker's branding so the
      // designer renders in customer mode. No subscription details for customers.
      const cust = await resolveCustomer(req.user);
      if (cust?.baker_id) {
        const { data: cbaker } = await supabase
          .from('bakers')
          .select('id, name, slug, logo_url, primary_color, accent_color, instagram_handle, website_url, tagline')
          .eq('id', cust.baker_id).single();
        const { data: c } = await supabase
          .from('customers').select('first_name, last_name').eq('id', cust.customer_id).maybeSingle();
        if (cbaker) {
          return res.json({
            baker: {
              id: cbaker.id, name: cbaker.name, slug: cbaker.slug,
              logo_url:         toPublicUrl(cbaker.logo_url),
              primary_color:    cbaker.primary_color,  accent_color: cbaker.accent_color,
              instagram_handle: cbaker.instagram_handle, website_url: cbaker.website_url,
              tagline:          cbaker.tagline,
            },
            user: { firstName: c?.first_name ?? '', lastName: c?.last_name ?? '', email: req.user.email },
          });
        }
      }
      return res.status(404).json({ error: 'No baker account found' });
    }

    const { data: baker } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, primary_color, accent_color, instagram_handle, website_url, tagline, storefront_theme_id, portrait_url, storefront_published, storefront_customizations')
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
        storefront_theme_id: baker.storefront_theme_id,
        portrait_url:     toPublicUrl(baker.portrait_url),
        storefront_published: baker.storefront_published,
        storefront_customizations: baker.storefront_customizations || {},
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

    const ALLOWED = ['primary_color', 'accent_color', 'logo_url', 'instagram_handle', 'website_url', 'tagline', 'story', 'portrait_url'];
    const updates = {};
    for (const f of ALLOWED) {
      if (f in req.body) updates[f] = req.body[f] || null;
    }
    // storefront_theme_id is a FK to the themes master table — validate it exists and
    // is available (is_active); never coerce the NOT-NULL column to null.
    if ('storefront_theme_id' in req.body) {
      const id = Number(req.body.storefront_theme_id);
      const { data: theme } = await supabase
        .from('storefront_themes').select('id, is_active').eq('id', id).maybeSingle();
      if (!theme)           return res.status(400).json({ error: 'Unknown storefront_theme_id' });
      if (!theme.is_active) return res.status(400).json({ error: 'That theme is not available yet' });
      updates.storefront_theme_id = id;
    }
    // storefront_customizations is jsonb (NOT NULL) — only set when a real object is sent.
    if (req.body.storefront_customizations && typeof req.body.storefront_customizations === 'object') {
      updates.storefront_customizations = req.body.storefront_customizations;
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

// ── GET /api/baker/storefront-themes ──────────────────────────────────────────
// The themes master list for the Settings → Store Settings → Themes picker.
// Returns [{ id, key, name, description, is_active }] (is_active=false = coming soon).
router.get('/baker/storefront-themes', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('storefront_themes')
      .select('id, key, name, description, is_active')
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ themes: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/baker/storefront-photos ──────────────────────────────────────────
// The baker's gallery photos (ordered) for the storefront slideshow / customiser.
router.get('/baker/storefront-photos', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data, error } = await supabase
      .from('baker_storefront_photos')
      .select('id, storage_key, caption, sort_order')
      .eq('baker_id', contact.baker_id)
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });

    res.json({ photos: (data ?? []).map(p => ({ id: p.id, key: p.storage_key, url: toPublicUrl(p.storage_key), caption: p.caption })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baker/storefront-photos ─────────────────────────────────────────
// Add one gallery photo (already uploaded to R2). Body: { storage_key | key, caption? }.
// A row is written immediately on upload so every R2 object is tracked + manageable.
router.post('/baker/storefront-photos', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const storage_key = req.body?.storage_key || req.body?.key;
    if (!storage_key) return res.status(400).json({ error: 'storage_key is required' });

    const { data: last } = await supabase
      .from('baker_storefront_photos').select('sort_order')
      .eq('baker_id', contact.baker_id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const sort_order = (last?.sort_order ?? -1) + 1;

    const { data, error } = await supabase
      .from('baker_storefront_photos')
      .insert({ baker_id: contact.baker_id, storage_key, caption: req.body?.caption || null, sort_order })
      .select('id, storage_key, caption, sort_order')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ id: data.id, key: data.storage_key, url: toPublicUrl(data.storage_key), caption: data.caption, sort_order: data.sort_order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/baker/storefront-photos/:id ───────────────────────────────────
// Remove a photo: deletes the row AND its R2 object (no orphans left behind).
router.delete('/baker/storefront-photos/:id', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data: row } = await supabase
      .from('baker_storefront_photos').select('id, storage_key')
      .eq('id', req.params.id).eq('baker_id', contact.baker_id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Photo not found' });

    const { error } = await supabase.from('baker_storefront_photos').delete().eq('id', row.id);
    if (error) return res.status(500).json({ error: error.message });
    try { await deleteObject(row.storage_key); } catch (e) { /* best-effort R2 cleanup */ }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/baker/storefront-photos ──────────────────────────────────────────
// Save captions + order for EXISTING photos. Body: { photos: [{ id, caption?, sort_order? }] }.
// Metadata-only — use POST/DELETE to add/remove.
router.put('/baker/storefront-photos', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const photos = Array.isArray(req.body?.photos) ? req.body.photos : null;
    if (!photos) return res.status(400).json({ error: 'photos array is required' });

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (!p?.id) continue;
      await supabase.from('baker_storefront_photos')
        .update({ caption: p.caption ?? null, sort_order: p.sort_order ?? i })
        .eq('id', p.id).eq('baker_id', contact.baker_id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baker/storefront/publish  +  /unpublish ─────────────────────────
// Flip the storefront live/draft. Required before the public page renders or the
// baker can invite customers.
async function setPublished(req, res, published) {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });
    const { error } = await supabase.from('bakers')
      .update({ storefront_published: published }).eq('id', contact.baker_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, storefront_published: published });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
router.post('/baker/storefront/publish',   requireAuth, requireCapability('store:manage'), (req, res) => setPublished(req, res, true));
router.post('/baker/storefront/unpublish', requireAuth, requireCapability('store:manage'), (req, res) => setPublished(req, res, false));

// ── GET /api/baker/testimonials ───────────────────────────────────────────────
// The baker's customer reviews (ordered) for the storefront + customiser.
router.get('/baker/testimonials', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data, error } = await supabase
      .from('baker_testimonials')
      .select('id, quote, author, occasion, sort_order')
      .eq('baker_id', contact.baker_id)
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ testimonials: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/baker/testimonials ───────────────────────────────────────────────
// Replace the baker's whole ordered review set. Body: { testimonials: [{ quote, author?, occasion? }] }.
// Rows without a quote are dropped. (Pure text — no external resource, so replace is fine.)
router.put('/baker/testimonials', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const list = Array.isArray(req.body?.testimonials) ? req.body.testimonials : null;
    if (!list) return res.status(400).json({ error: 'testimonials array is required' });

    const rows = list
      .filter(t => t?.quote && t.quote.trim())
      .map((t, i) => ({ baker_id: contact.baker_id, quote: t.quote.trim(), author: t.author?.trim() || null, occasion: t.occasion?.trim() || null, sort_order: i }));

    const { error: delErr } = await supabase
      .from('baker_testimonials').delete().eq('baker_id', contact.baker_id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (rows.length) {
      const { error: insErr } = await supabase.from('baker_testimonials').insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
    res.json({ ok: true, count: rows.length });
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
