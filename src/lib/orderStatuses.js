// ── Order status lifecycle (read-through cache over the order_statuses table) ──
// Statuses live in the DB (order_statuses) so they are managed data, not a code
// array. This module is the ONE place that reads them, with a small in-process
// cache (the vocabulary is tiny and changes rarely). Callers ask by key — there
// are no magic ids. orders.status is FK-constrained to these keys, so the DB is
// the source of truth and this cache only saves round-trips.

import { supabase } from '../services/supabase.js';

let cache = null;          // array of status rows, ordered by sort_order
let loadedAt = 0;
const TTL_MS = 5 * 60 * 1000;   // refresh at most every 5 min; statuses rarely change

async function load() {
  const { data, error } = await supabase
    .from('order_statuses')
    .select('key, label, phase, sort_order, is_terminal, customer_visible, tone')
    .order('sort_order');
  if (error) throw new Error(`Failed to load order_statuses: ${error.message}`);
  cache = data ?? [];
  loadedAt = Date.now();
  return cache;
}

// All statuses, ordered by the lifecycle timeline. Cached.
export async function getOrderStatuses() {
  if (!cache || Date.now() - loadedAt > TTL_MS) return load();
  return cache;
}

// The set of valid status keys (for validating a requested transition target).
export async function getValidStatusKeys() {
  return (await getOrderStatuses()).map(s => s.key);
}

export async function isValidStatusKey(key) {
  return (await getValidStatusKeys()).includes(key);
}

// True while the order is still in the quote/refinement window (phase 'quote' =
// initiated / requested / quoted). The design + price-bearing fields are editable
// only here; once 'confirmed' (fulfillment) the design is locked.
export async function isQuotePhase(key) {
  const s = (await getOrderStatuses()).find(x => x.key === key);
  return s?.phase === 'quote';
}

// Force a reload (e.g. after editing the table). Mostly for tests/ops.
export function invalidateOrderStatusCache() {
  cache = null;
}
