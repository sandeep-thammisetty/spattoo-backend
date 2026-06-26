import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

// ── GET /api/baker/dashboard ──────────────────────────────────────────────────
router.get('/baker/dashboard', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const { baker_id } = appUser;

    const now        = new Date();
    const today      = now.toISOString().slice(0, 10);
    const tomorrow   = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
    const in7Days    = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const ago7Days   = new Date(now.getTime() - 7  * 86400000).toISOString();
    const ago14Days  = new Date(now.getTime() - 14 * 86400000).toISOString();
    const ago90Days  = new Date(now.getTime() - 90 * 86400000).toISOString();

    // Run all queries in parallel
    const [
      weekOrders,
      pendingOrders,
      dueSoon,
      activeCustomers,
      recentOrders,
      needsAttention,
      upcomingDeliveries,
      allStatuses,
      flavourOrders,
      customerOrders,
    ] = await Promise.all([
      // Orders placed in last 7 days
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('baker_id', baker_id).gte('created_at', ago7Days),

      // Awaiting-baker count (new requests needing review)
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('baker_id', baker_id).eq('status', 'requested'),

      // Due today or tomorrow
      supabase.from('orders')
        .select('id, delivery_date, delivery_mode, status, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .in('delivery_date', [today, tomorrow])
        .not('status', 'in', '(completed,cancelled,declined,expired)')
        .order('delivery_date'),

      // Active customers
      supabase.from('customers').select('id', { count: 'exact', head: true })
        .eq('baker_id', baker_id).eq('is_active', true),

      // Orders per day last 14 days
      supabase.from('orders').select('created_at')
        .eq('baker_id', baker_id).gte('created_at', ago14Days),

      // Needs attention: due today or tomorrow, not yet ready/delivered/cancelled
      supabase.from('orders')
        .select('id, delivery_date, delivery_time, delivery_mode, status, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .in('delivery_date', [today, tomorrow])
        .not('status', 'in', '(ready,completed,cancelled,declined,expired)')
        .order('delivery_date').order('delivery_time'),

      // Upcoming deliveries next 7 days
      supabase.from('orders')
        .select('id, delivery_date, delivery_mode, delivery_time, status, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .gte('delivery_date', today).lte('delivery_date', in7Days)
        .not('status', 'in', '(completed,cancelled,declined,expired)')
        .order('delivery_date').order('delivery_time'),

      // All non-cancelled orders for status breakdown + delivery split
      supabase.from('orders').select('status, delivery_mode')
        .eq('baker_id', baker_id),

      // Orders with flavours in last 90 days
      supabase.from('orders').select('flavours')
        .eq('baker_id', baker_id).gte('created_at', ago90Days)
        .not('flavours', 'is', null),

      // New customers in last 7 days
      supabase.from('customers')
        .select('id, first_name, last_name, phone, email, created_at')
        .eq('baker_id', baker_id)
        .gte('created_at', ago7Days)
        .order('created_at', { ascending: false }),
    ]);

    // ── Orders per day (last 14 days) ────────────────────────────────────────
    const dayMap = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      dayMap[d] = 0;
    }
    (recentOrders.data ?? []).forEach(o => {
      const d = o.created_at.slice(0, 10);
      if (d in dayMap) dayMap[d]++;
    });
    const ordersPerDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

    // ── Status breakdown ─────────────────────────────────────────────────────
    const statusMap = {};
    (allStatuses.data ?? []).forEach(o => {
      statusMap[o.status] = (statusMap[o.status] ?? 0) + 1;
    });
    const statusBreakdown = Object.entries(statusMap)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // ── Delivery split ───────────────────────────────────────────────────────
    const pickupCount   = (allStatuses.data ?? []).filter(o => o.delivery_mode !== 'home_delivery').length;
    const deliveryCount = (allStatuses.data ?? []).filter(o => o.delivery_mode === 'home_delivery').length;

    // ── Top flavours ─────────────────────────────────────────────────────────
    const flavourMap = {};
    (flavourOrders.data ?? []).forEach(o => {
      (o.flavours ?? []).forEach(f => {
        const name = f.name?.trim();
        if (name) flavourMap[name] = (flavourMap[name] ?? 0) + 1;
      });
    });
    const topFlavours = Object.entries(flavourMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const newCustomers = (customerOrders.data ?? []).map(c => ({
      id:         c.id,
      name:       `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(),
      phone:      c.phone ?? null,
      email:      c.email ?? null,
      created_at: c.created_at,
    }));

    res.json({
      stats: {
        ordersThisWeek:  weekOrders.count    ?? 0,
        pendingCount:    pendingOrders.count  ?? 0,
        dueToday:        (dueSoon.data ?? []).filter(o => o.delivery_date === today).length,
        dueTomorrow:     (dueSoon.data ?? []).filter(o => o.delivery_date === tomorrow).length,
        activeCustomers: activeCustomers.count ?? 0,
      },
      needsAttention:    needsAttention.data    ?? [],
      upcomingDeliveries: upcomingDeliveries.data ?? [],
      ordersPerDay,
      statusBreakdown,
      deliverySplit: { pickup: pickupCount, homeDelivery: deliveryCount },
      topFlavours,
      newCustomers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/baker/dashboard/breakdown?period=7d|30d|90d|all ─────────────────
// Lightweight endpoint — only status breakdown + delivery split for a period.
// Used by the dashboard period selector without refetching everything.

router.get('/baker/dashboard/breakdown', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const { baker_id } = appUser;
    const period = req.query.period ?? '30d';
    const DAYS = { '7d': 7, '30d': 30, '90d': 90 };
    const days = DAYS[period];

    let query = supabase
      .from('orders').select('status, delivery_mode')
      .eq('baker_id', baker_id);

    if (days) {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      query = query.gte('created_at', from);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const statusMap = {};
    (data ?? []).forEach(o => { statusMap[o.status] = (statusMap[o.status] ?? 0) + 1; });
    const statusBreakdown = Object.entries(statusMap)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    const pickupCount   = (data ?? []).filter(o => o.delivery_mode !== 'home_delivery').length;
    const deliveryCount = (data ?? []).filter(o => o.delivery_mode === 'home_delivery').length;

    res.json({
      statusBreakdown,
      deliverySplit: { pickup: pickupCount, homeDelivery: deliveryCount },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
