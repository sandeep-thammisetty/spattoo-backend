import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePrincipal, requireCapability } from '../middleware/rbac.js';

const router = Router();

// ── GET /api/me ───────────────────────────────────────────────────────────────
// The client's source of truth for what to show. Capabilities are resolved
// server-side from the verified identity — never trusted from the request.
router.get('/me', requireAuth, resolvePrincipal, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    firstName: req.firstName ?? null,
    lastName: req.lastName ?? null,
    role: req.role,                 // null when the identity isn't recognized
    bakerId: req.bakerId,
    customerId: req.customerId,     // set when the principal is an invited customer
    capabilities: req.capabilities, // ['*'] for super admin
  });
});

// Everything below manages the RBAC matrix itself — super-admin territory.
const ADMIN = [requireAuth, requireCapability('admin:manage')];

// ── GET /api/admin/rbac ───────────────────────────────────────────────────────
// Roles, capabilities, and the matrix the screen renders/edits.
router.get('/admin/rbac', ...ADMIN, async (_req, res) => {
  const [roles, capabilities, map] = await Promise.all([
    supabase.from('roles').select('*').order('sort_order'),
    supabase.from('capabilities').select('*').order('sort_order'),
    supabase.from('role_capabilities').select('role_key, capability_key'),
  ]);
  if (roles.error)        return res.status(500).json({ error: roles.error.message });
  if (capabilities.error) return res.status(500).json({ error: capabilities.error.message });
  if (map.error)          return res.status(500).json({ error: map.error.message });

  // matrix: { [roleKey]: [capabilityKey, ...] }
  const matrix = {};
  for (const r of roles.data) matrix[r.key] = [];
  for (const m of map.data) (matrix[m.role_key] ??= []).push(m.capability_key);

  res.json({ roles: roles.data, capabilities: capabilities.data, matrix });
});

// ── POST /api/admin/capabilities ──────────────────────────────────────────────
// Add a new capability to the catalog. Wire it onto routes in code separately.
router.post('/admin/capabilities', ...ADMIN, async (req, res) => {
  const { key, label, description, category, is_sensitive, sort_order } = req.body ?? {};
  if (!key?.trim() || !label?.trim()) {
    return res.status(400).json({ error: 'key and label are required' });
  }
  if (!/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(key.trim())) {
    return res.status(400).json({ error: 'key must look like "resource:action"' });
  }
  const { data, error } = await supabase
    .from('capabilities')
    .insert({
      key: key.trim(),
      label: label.trim(),
      description: description?.trim() || null,
      category: category?.trim() || 'baker',
      is_sensitive: !!is_sensitive,
      sort_order: Number.isFinite(sort_order) ? sort_order : 100,
    })
    .select()
    .single();
  if (error) {
    const status = error.code === '23505' ? 409 : 500; // unique_violation
    return res.status(status).json({ error: error.message });
  }
  res.status(201).json(data);
});

// ── PUT /api/admin/roles/:roleKey/capabilities ────────────────────────────────
// Replace a role's full capability set. Body: { capabilities: [key, ...] }.
// Super roles can't be edited — they implicitly hold everything.
router.put('/admin/roles/:roleKey/capabilities', ...ADMIN, async (req, res) => {
  const { roleKey } = req.params;
  const next = Array.isArray(req.body?.capabilities) ? req.body.capabilities : null;
  if (!next) return res.status(400).json({ error: 'capabilities must be an array' });

  const { data: role } = await supabase
    .from('roles').select('key, is_super').eq('key', roleKey).maybeSingle();
  if (!role) return res.status(404).json({ error: 'Unknown role' });
  if (role.is_super) {
    return res.status(400).json({ error: 'Super-admin role holds all capabilities and cannot be edited' });
  }

  // Validate every key exists in the catalog before mutating.
  const { data: known } = await supabase.from('capabilities').select('key');
  const knownKeys = new Set((known ?? []).map(c => c.key));
  const bad = next.filter(k => !knownKeys.has(k));
  if (bad.length) return res.status(400).json({ error: `Unknown capabilities: ${bad.join(', ')}` });

  // Replace: clear then insert the new set.
  const del = await supabase.from('role_capabilities').delete().eq('role_key', roleKey);
  if (del.error) return res.status(500).json({ error: del.error.message });

  if (next.length) {
    const rows = [...new Set(next)].map(capability_key => ({ role_key: roleKey, capability_key }));
    const ins = await supabase.from('role_capabilities').insert(rows);
    if (ins.error) return res.status(500).json({ error: ins.error.message });
  }

  res.json({ role_key: roleKey, capabilities: [...new Set(next)] });
});

export default router;
