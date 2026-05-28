import { Router } from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../services/supabase.js';
import { putObject } from '../services/r2.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Public endpoint — no auth required. Called by the customer-facing designer.
//
// Body:
//   bakerSlug            string   required
//   customer             object   required  { email, firstName, lastName, phone? }
//   designSnapshot       object   required  full design JSON
//   designThumbnail      string?  base64 PNG data URL (e.g. "data:image/png;base64,...")
//   weightKg             number?
//   flavours             array?   [{ tier: 0, flavour: "vanilla" }, ...]
//   specialInstructions  string?
//   deliveryDate         string?  ISO date  "2026-06-15"
//   deliveryTime         string?  "14:30"
//   deliveryMode         string   "pickup" | "home_delivery"  (default: "pickup")
//   deliveryAddress      string?  required when deliveryMode = "home_delivery"

// ── GET /api/flavours?bakerSlug=xxx ──────────────────────────────────────────
// Public. Returns effective flavour list for a baker:
//   active global flavours (minus exclusions) + baker's custom flavours

router.get('/flavours', async (req, res) => {
  try {
    const { bakerSlug } = req.query;
    if (!bakerSlug) return res.status(400).json({ error: 'bakerSlug is required' });

    const { data: baker } = await supabase
      .from('bakers').select('id').eq('slug', bakerSlug).eq('is_active', true).maybeSingle();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    // Excluded global flavour IDs for this baker
    const { data: exclusions } = await supabase
      .from('baker_flavour_exclusions')
      .select('flavour_id')
      .eq('baker_id', baker.id);
    const excludedIds = (exclusions ?? []).map(e => e.flavour_id);

    // Active global flavours minus exclusions
    let globalQuery = supabase
      .from('flavours')
      .select('id, name, description, sort_order')
      .eq('is_active', true)
      .order('sort_order').order('name');
    if (excludedIds.length) globalQuery = globalQuery.not('id', 'in', `(${excludedIds.join(',')})`);
    const { data: globals } = await globalQuery;

    // Baker's custom flavours
    const { data: custom } = await supabase
      .from('baker_flavours')
      .select('id, name, description, sort_order')
      .eq('baker_id', baker.id).eq('is_active', true)
      .order('sort_order').order('name');

    const result = [
      ...(globals ?? []).map(f => ({ ...f, source: 'global' })),
      ...(custom  ?? []).map(f => ({ ...f, source: 'baker'  })),
    ];

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {
  try {
    const {
      bakerSlug,
      customer,
      designSnapshot,
      designThumbnail,
      weightKg,
      flavours,
      specialInstructions,
      deliveryDate,
      deliveryTime,
      deliveryMode = 'pickup',
      deliveryAddress,
    } = req.body;

    // ── Validate required fields ────────────────────────────────────────────
    if (!bakerSlug)                         return res.status(400).json({ error: 'bakerSlug is required' });
    if (!customer?.firstName)               return res.status(400).json({ error: 'customer.firstName is required' });
    if (!customer?.phone && !customer?.email) return res.status(400).json({ error: 'customer.phone or customer.email is required' });
    if (!designSnapshot)                    return res.status(400).json({ error: 'designSnapshot is required' });
    if (!['pickup', 'home_delivery'].includes(deliveryMode)) {
      return res.status(400).json({ error: 'deliveryMode must be pickup or home_delivery' });
    }
    if (deliveryMode === 'home_delivery' && !deliveryAddress) {
      return res.status(400).json({ error: 'deliveryAddress is required for home_delivery' });
    }

    // ── Resolve baker ───────────────────────────────────────────────────────
    const { data: baker, error: bakerError } = await supabase
      .from('bakers')
      .select('id')
      .eq('slug', bakerSlug)
      .eq('is_active', true)
      .maybeSingle();

    if (bakerError) return res.status(500).json({ error: bakerError.message });
    if (!baker)     return res.status(404).json({ error: 'Baker not found' });

    const bakerId = baker.id;

    // ── Upsert customer ─────────────────────────────────────────────────────
    // Look up by email if provided, otherwise by phone.
    const emailNorm = customer.email?.toLowerCase().trim() || null;
    const phoneNorm = customer.phone?.trim() || null;

    let lookupQuery = supabase.from('customers').select('id').eq('baker_id', bakerId);
    if (emailNorm) {
      lookupQuery = lookupQuery.eq('email', emailNorm);
    } else {
      lookupQuery = lookupQuery.eq('phone', phoneNorm);
    }

    let { data: existingCustomer } = await lookupQuery.maybeSingle();

    if (!existingCustomer) {
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          baker_id:   bakerId,
          email:      emailNorm,
          first_name: customer.firstName,
          last_name:  customer.lastName ?? null,
          phone:      phoneNorm,
          source:     'online_order',
        })
        .select('id')
        .single();

      if (customerError) return res.status(500).json({ error: customerError.message });
      existingCustomer = newCustomer;
    }

    // ── Upload thumbnail to R2 ──────────────────────────────────────────────
    let thumbnailUrl = null;
    if (designThumbnail) {
      const base64Data = designThumbnail.replace(/^data:image\/png;base64,/, '');
      const buffer     = Buffer.from(base64Data, 'base64');
      const key        = `orders/thumbnails/${randomUUID()}.png`;
      thumbnailUrl     = await putObject(key, buffer, 'image/png');
    }

    // ── Insert order ────────────────────────────────────────────────────────
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        baker_id:             bakerId,
        customer_id:          existingCustomer.id,
        design_snapshot:      designSnapshot,
        design_thumbnail_url: thumbnailUrl,
        weight_kg:            weightKg ?? null,
        flavours:             flavours ?? null,
        special_instructions: specialInstructions ?? null,
        delivery_date:        deliveryDate ?? null,
        delivery_time:        deliveryTime ?? null,
        delivery_mode:        deliveryMode,
        delivery_address:     deliveryAddress ?? null,
        status:               'pending',
      })
      .select('id, created_at')
      .single();

    if (orderError) return res.status(500).json({ error: orderError.message });

    res.status(201).json({
      orderId:   order.id,
      createdAt: order.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/baker/customers ──────────────────────────────────────────────────
// Returns customers for the authenticated baker. Optional ?q= for phone/name search.

router.get('/baker/customers', requireAuth, async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    let query = supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, created_at')
      .eq('baker_id', appUser.baker_id)
      .order('first_name');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders ───────────────────────────────────────────────────────────
// Baker-facing: list orders for the authenticated baker's account.
// Query params: status, from, to (ISO dates)

router.get('/orders', requireAuth, async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const { status, from, to } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        id, status, weight_kg, delivery_date, delivery_time,
        delivery_mode, delivery_address, flavours,
        special_instructions, design_thumbnail_url, design_snapshot,
        approved_at, created_at, updated_at,
        customers ( id, email, first_name, last_name, phone )
      `)
      .eq('baker_id', appUser.baker_id)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (from)   query = query.gte('created_at', from);
    if (to)     query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders/:id ───────────────────────────────────────────────────────
// Returns full order including design_snapshot (for reconstructing the cake).

router.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        customers ( id, email, first_name, last_name, phone )
      `)
      .eq('id', req.params.id)
      .eq('baker_id', appUser.baker_id)
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/orders/:id/status ──────────────────────────────────────────────
// Baker approves, moves to in_progress, marks ready, etc.

const VALID_STATUSES = ['pending', 'approved', 'in_progress', 'ready', 'delivered', 'cancelled'];

router.patch('/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id, id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const updates = { status };
    if (status === 'approved') {
      updates.approved_at = new Date().toISOString();
      updates.approved_by = appUser.id;
    }

    const { data: order, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .eq('baker_id', appUser.baker_id)
      .select('id, status, approved_at')
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
