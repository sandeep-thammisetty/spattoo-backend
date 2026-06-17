import { supabase } from '../services/supabase.js';

// ── Role & capability resolution ──────────────────────────────────────────────
// Authorization is a POSITIVE grant. An unrecognized identity gets no role and
// no capabilities (deny-by-default) — it is NEVER inferred from the absence of a
// row. The role↔capability matrix lives in the DB so it can be managed from the
// admin UI; `admin` (is_super) holds every capability, including future ones.

const SUPER = '*';

// Resolve { role, bakerId, capabilities } for an authenticated Supabase user.
export async function loadPrincipal(user) {
  const userId = user.id;

  // 1. Admin? — explicit positive grant only.
  const { data: admin } = await supabase
    .from('admins')
    .select('role')
    .eq('auth_user_id', userId)
    .maybeSingle();

  let role = null;
  let bakerId = null;

  if (admin) {
    role = admin.role; // 'admin' | 'admin_staff'
  } else {
    // 2. Baker app-user?
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id, role')
      .eq('auth_user_id', userId)
      .maybeSingle();
    if (appUser) {
      role = appUser.role;        // 'owner' | 'staff'
      bakerId = appUser.baker_id;
    }
    // 3. (future) customers table → role = 'customer', once customers authenticate.
  }

  return { role, bakerId, capabilities: await capabilitiesForRole(role) };
}

// Capability keys for a role. is_super → ['*'] (matches every capability).
export async function capabilitiesForRole(role) {
  if (!role) return [];

  const { data: roleRow } = await supabase
    .from('roles')
    .select('is_super')
    .eq('key', role)
    .maybeSingle();
  if (roleRow?.is_super) return [SUPER];

  const { data } = await supabase
    .from('role_capabilities')
    .select('capability_key')
    .eq('role_key', role);
  return (data ?? []).map(r => r.capability_key);
}

export function hasCapability(capabilities, cap) {
  return capabilities?.includes(SUPER) || capabilities?.includes(cap);
}

// Middleware: attach req.role / req.bakerId / req.capabilities. Run after requireAuth.
export async function resolvePrincipal(req, res, next) {
  try {
    const p = await loadPrincipal(req.user);
    req.role = p.role;
    req.bakerId = p.bakerId;
    req.capabilities = p.capabilities;
    next();
  } catch (err) {
    next(err);
  }
}

// Guard: requires a specific capability. Run after requireAuth; lazily resolves
// the principal if resolvePrincipal hasn't already, so routes can use it directly:
//   router.post('/x', requireAuth, requireCapability('customer:manage'), handler)
export function requireCapability(cap) {
  return async (req, res, next) => {
    try {
      if (req.capabilities === undefined) {
        const p = await loadPrincipal(req.user);
        req.role = p.role;
        req.bakerId = p.bakerId;
        req.capabilities = p.capabilities;
      }
      if (hasCapability(req.capabilities, cap)) return next();
      return res.status(403).json({ error: 'Forbidden', missing: cap });
    } catch (err) {
      next(err);
    }
  };
}
