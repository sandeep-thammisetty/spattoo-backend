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
