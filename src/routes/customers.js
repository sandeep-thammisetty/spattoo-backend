import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Resolve baker_id from auth user ──────────────────────────────────────────
async function getBakerId(userId) {
  const { data } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  return data?.baker_id ?? null;
}

// ── GET /api/baker/customers ──────────────────────────────────────────────────
// ?include_inactive=true  → include deactivated customers
// ?q=search               → filter by name / phone / email

router.get('/baker/customers', requireAuth, async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const includeInactive = req.query.include_inactive === 'true';
    const q    = req.query.q?.trim().toLowerCase();
    const from = req.query.from;

    let query = supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .eq('baker_id', bakerId)
      .order('first_name');

    if (!includeInactive) query = query.eq('is_active', true);
    if (from)             query = query.gte('created_at', from);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const result = q
      ? data.filter(c => {
          const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.toLowerCase();
          return name.includes(q) || (c.phone ?? '').includes(q) || (c.email ?? '').toLowerCase().includes(q);
        })
      : data;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baker/customers ─────────────────────────────────────────────────
// Body: { firstName, lastName?, email?, phone? }

router.post('/baker/customers', requireAuth, async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone } = req.body;
    if (!firstName?.trim())                  return res.status(400).json({ error: 'firstName is required' });
    if (!phone?.trim() && !email?.trim())    return res.status(400).json({ error: 'phone or email is required' });

    const { data, error } = await supabase
      .from('customers')
      .insert({
        baker_id:   bakerId,
        first_name: firstName.trim(),
        last_name:  lastName?.trim() || null,
        email:      email?.trim().toLowerCase() || null,
        phone:      phone?.trim() || null,
        source:     'manual',
        is_active:  true,
      })
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id ────────────────────────────────────────────
// Body: { firstName?, lastName?, email?, phone? }

router.patch('/baker/customers/:id', requireAuth, async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone } = req.body;

    const updates = {};
    if (firstName !== undefined) updates.first_name = firstName?.trim() || null;
    if (lastName  !== undefined) updates.last_name  = lastName?.trim()  || null;
    if (email     !== undefined) updates.email      = email?.trim().toLowerCase() || null;
    if (phone     !== undefined) updates.phone      = phone?.trim() || null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });
    if (updates.first_name === null)   return res.status(400).json({ error: 'firstName cannot be empty' });

    const { data, error } = await supabase
      .from('customers').update(updates)
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id/deactivate ─────────────────────────────────

router.patch('/baker/customers/:id/deactivate', requireAuth, async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: false })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id/reactivate ─────────────────────────────────

router.patch('/baker/customers/:id/reactivate', requireAuth, async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: true })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
