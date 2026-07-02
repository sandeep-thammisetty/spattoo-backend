import { supabase } from '../services/supabase.js';

// SEC-7 — one shared tenant-scope for reads of catalog tables that carry a nullable `baker_id`
// (global/shared rows = NULL; a tenant's private rows = that baker's id).
//
// Restricts a PostgREST query to what the caller may see: GLOBAL rows + their OWN tenant's rows.
// Internal admins (req.isAdmin) bypass and see everything. Callers with no tenant (null bakerId)
// get global rows only.
//
// SAFETY: req.bakerId is SERVER-RESOLVED from the auth token (middleware/rbac.js → loadPrincipal),
// never a client-supplied value, so interpolating it into the .or() filter is not injection-prone
// (unlike client params — see SEC-10). It is always a smallint/int or null.
//
// Kept as ONE helper (not pasted per route) so the rule can't drift across call sites — the exact
// duplication class that let SEC-7 exist (list routes were scoped, by-id routes were not).
export function scopeCatalogRead(query, req) {
  if (req.isAdmin) return query;                                   // admin: unrestricted
  return req.bakerId
    ? query.or(`baker_id.is.null,baker_id.eq.${req.bakerId}`)      // global + own tenant
    : query.is('baker_id', null);                                  // no tenant: global only
}

// SEC-14 — assert that a specific row in a TENANT-PRIVATE table (orders, customers, storefront
// photos, …) belongs to the caller's baker, and return it (or null → the caller responds 404).
//
// This consolidates the "read a row by id, then filter by baker_id" ownership check that was
// hand-written ~a dozen times across order/baker/customer routes. Its OMISSION on by-id routes is
// exactly what caused SEC-2 (cross-tenant delete) and SEC-7 (cross-tenant read) — the list route
// carried the filter, the sibling by-id route forgot it. Centralising it means a by-id read can no
// longer be written WITHOUT the tenant filter — there is no manual `.eq('baker_id', …)` to drop.
//
// Uses the SERVER-RESOLVED req.bakerId (middleware/rbac.js → ensurePrincipal), never a client value
// (so it can't be spoofed — cf. SEC-10). NO admin bypass (unlike scopeCatalogRead): these rows are
// per-tenant and baker routes have no admin caller — an admin/non-baker has req.bakerId == null,
// which can never match, so they get null (→ 404). A wrong-tenant miss is indistinguishable from a
// nonexistent id → no enumeration oracle. `select` lets callers pull the columns they also need.
export async function assertBakerOwns(req, table, id, { select = 'id' } = {}) {
  if (!req.bakerId) return null;                                   // no tenant → owns nothing
  const { data, error } = await supabase
    .from(table).select(select)
    .eq('id', id).eq('baker_id', req.bakerId)
    .maybeSingle();
  if (error) throw error;                                          // → route's catch → serverError()
  return data ?? null;
}
