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
  let customerId = null;
  let firstName = null;
  let lastName = null;

  if (admin) {
    role = admin.role; // 'admin' | 'admin_staff'
  } else {
    // 2. Baker app-user?
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id, role, first_name, last_name')
      .eq('auth_user_id', userId)
      .maybeSingle();
    if (appUser) {
      role = appUser.role;        // 'owner' | 'staff'
      bakerId = appUser.baker_id;
      firstName = appUser.first_name;
      lastName = appUser.last_name;
    } else {
      // 3. Customer? Access is invite-gated: a verified contact only becomes a
      //    'customer' principal while a VALID invite exists. Baker context comes
      //    from that invite — there is no global customer session.
      const resolved = await resolveCustomer(user);
      if (resolved) {
        role = 'customer';
        bakerId = resolved.baker_id;
        customerId = resolved.customer_id;
        firstName = resolved.first_name;
        lastName = resolved.last_name;
      }
    }
  }

  return { role, bakerId, customerId, firstName, lastName, capabilities: await capabilitiesForRole(role) };
}

// Match the verified contact (email/phone from the OTP session) to a customer,
// gated by a currently-valid invite. Returns { customer_id, baker_id } or null.
// MVP: if valid invites exist for more than one baker, the most recent wins.
export async function resolveCustomer(user) {
  const orParts = [];
  if (user.email) orParts.push(`email.eq.${user.email}`);
  if (user.phone) orParts.push(`phone.eq.${user.phone}`);
  if (!orParts.length) return null;

  const { data: customers } = await supabase
    .from('customers')
    .select('id, first_name, last_name')
    .or(orParts.join(','));
  if (!customers?.length) return null;

  const nowIso = new Date().toISOString();
  const { data: invites } = await supabase
    .from('customer_invites')
    .select('customer_id, baker_id, expires_at')
    .in('customer_id', customers.map(c => c.id))
    .in('status', ['pending', 'sent', 'opened'])      // not completed/expired/revoked
    .order('created_at', { ascending: false });

  const valid = (invites ?? []).find(iv => !iv.expires_at || iv.expires_at > nowIso);
  if (!valid) return null;
  const match = customers.find(c => c.id === valid.customer_id);
  return {
    customer_id: valid.customer_id,
    baker_id: valid.baker_id,
    first_name: match?.first_name ?? null,
    last_name: match?.last_name ?? null,
  };
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
    req.customerId = p.customerId;
    req.firstName = p.firstName;
    req.lastName = p.lastName;
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
        req.customerId = p.customerId;
        req.firstName = p.firstName;
        req.lastName = p.lastName;
        req.capabilities = p.capabilities;
      }
      if (hasCapability(req.capabilities, cap)) return next();
      return res.status(403).json({ error: 'Forbidden', missing: cap });
    } catch (err) {
      next(err);
    }
  };
}
