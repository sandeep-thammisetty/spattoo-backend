import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS = 'id, key, label, config, is_active, sort_order, updated_at';

// Validate + normalize a material `config`. Today it carries the ordered style list the designer reads:
// config.styles = ['wave','swirl',…] — cake_textures keys, in display order. `smooth` is the implicit
// always-first default and is dropped if present (never stored). Dupes/blanks are dropped so the stored
// shape stays predictable. Returns { ok, value } | { ok:false, error }.
function normalizeConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const raw = config.styles;
  if (raw != null && !Array.isArray(raw)) {
    return { ok: false, error: 'config.styles must be an array' };
  }
  const seen = new Set();
  const styles = [];
  for (const s of raw ?? []) {
    const key = String(s ?? '').trim();
    if (!key || key === 'smooth' || seen.has(key)) continue;   // smooth is implicit; no dupes/blanks
    seen.add(key);
    styles.push(key);
  }
  return { ok: true, value: { ...config, styles } };
}

// ── Read (any authenticated designer user — overlays these onto the in-code seed) ──
// GET /api/materials — active materials, ordered.
router.get('/materials', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
      .select(FIELDS)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// GET /api/admin/materials — all (incl. inactive) for the editor.
router.get('/admin/materials', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
      .select(FIELDS)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/materials — create. Body: { key, label, config, sort_order? }
router.post('/admin/materials', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, sort_order } = req.body;
    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: 'key and label are required' });
    }
    const cfg = normalizeConfig(req.body.config);
    if (!cfg.ok) return res.status(400).json({ error: cfg.error });

    const { data, error } = await supabase
      .from('materials')
      .insert({
        key: key.trim(),
        label: label.trim(),
        config: cfg.value,
        sort_order: Number.isFinite(sort_order) ? sort_order : 0,
        is_active: true,
      })
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500; // 23505 = unique key violation
      return res.status(status).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// PATCH /api/admin/materials/:id — selective update (the editor mainly PATCHes config.styles).
router.patch('/admin/materials/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    const { key, label, is_active, sort_order } = req.body;
    if (key != null) updates.key = String(key).trim();
    if (label != null) updates.label = String(label).trim();
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.config != null) {
      const cfg = normalizeConfig(req.body.config);
      if (!cfg.ok) return res.status(400).json({ error: cfg.error });
      updates.config = cfg.value;
    }

    const { data, error } = await supabase
      .from('materials')
      .update(updates)
      .eq('id', req.params.id)
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
