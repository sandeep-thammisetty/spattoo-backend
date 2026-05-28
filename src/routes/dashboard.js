import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── GET /api/baker/dashboard ──────────────────────────────────────────────────
router.get('/baker/dashboard', requireAuth, async (req, res) => {
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
    const ago2Days   = new Date(now.getTime() - 2  * 86400000).toISOString();
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

      // Pending count
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('baker_id', baker_id).eq('status', 'pending'),

      // Due today or tomorrow
      supabase.from('orders')
        .select('id, delivery_date, delivery_mode, status, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .in('delivery_date', [today, tomorrow])
        .not('status', 'in', '(delivered,cancelled)')
        .order('delivery_date'),

      // Active customers
      supabase.from('customers').select('id', { count: 'exact', head: true })
        .eq('baker_id', baker_id).eq('is_active', true),

      // Orders per day last 14 days
      supabase.from('orders').select('created_at')
        .eq('baker_id', baker_id).gte('created_at', ago14Days),

      // Needs attention: pending > 2 days old
      supabase.from('orders')
        .select('id, created_at, customers(first_name, last_name)')
        .eq('baker_id', baker_id).eq('status', 'pending')
        .lt('created_at', ago2Days)
        .order('created_at'),

      // Upcoming deliveries next 7 days
      supabase.from('orders')
        .select('id, delivery_date, delivery_mode, delivery_time, status, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .gte('delivery_date', today).lte('delivery_date', in7Days)
        .not('status', 'in', '(delivered,cancelled)')
        .order('delivery_date').order('delivery_time'),

      // All non-cancelled orders for status breakdown + delivery split
      supabase.from('orders').select('status, delivery_mode')
        .eq('baker_id', baker_id),

      // Orders with flavours in last 90 days
      supabase.from('orders').select('flavours')
        .eq('baker_id', baker_id).gte('created_at', ago90Days)
        .not('flavours', 'is', null),

      // Orders with customer join for top customers
      supabase.from('orders')
        .select('customer_id, customers(first_name, last_name)')
        .eq('baker_id', baker_id)
        .not('status', 'eq', 'cancelled'),
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

    // ── Top customers ────────────────────────────────────────────────────────
    const custMap = {};
    (customerOrders.data ?? []).forEach(o => {
      if (!o.customer_id) return;
      const name = o.customers
        ? `${o.customers.first_name ?? ''} ${o.customers.last_name ?? ''}`.trim()
        : 'Unknown';
      if (!custMap[o.customer_id]) custMap[o.customer_id] = { name, count: 0 };
      custMap[o.customer_id].count++;
    });
    const topCustomers = Object.values(custMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

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
      topCustomers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
