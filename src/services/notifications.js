import { supabase } from './supabase.js';
import { jobQueue } from '../jobs/queue.js';

async function getTypeId(slug) {
  const { data } = await supabase
    .from('notification_types')
    .select('id')
    .eq('slug', slug)
    .single();
  return data?.id;
}

// Transactional outbox: the row is the durable record; we DISPATCH it immediately
// (push to the queue) instead of waiting for the sweeper poll — so the worker fetches
// it by id and sends with no per-notification status scan in the hot path. If the
// enqueue fails (e.g. Redis down) the row stays 'pending' and the sweeper backstop
// retries. We flip to 'enqueued' only while still 'pending', so a worker that already
// advanced the row (sent/failed) is never clobbered.
async function insertNotification(typeSlug, recipientEmail, payload) {
  const typeId = await getTypeId(typeSlug);
  if (!typeId) throw new Error(`Unknown notification type: ${typeSlug}`);

  const { data: row, error } = await supabase
    .from('notifications')
    .insert({ type_id: typeId, recipient_email: recipientEmail, payload })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert notification: ${error.message}`);

  try {
    await jobQueue.add('send_notification', { notificationId: row.id }, {
      attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
    await supabase
      .from('notifications')
      .update({ status: 'enqueued', attempts: 1 })
      .eq('id', row.id)
      .eq('status', 'pending');
  } catch (err) {
    console.error('[notifications] immediate enqueue failed, leaving for sweeper backstop:', err.message);
  }
}

// The baker's notification email. `bakers.email` is OPTIONAL at onboarding, so don't
// rely on it alone — fall back to the primary app-user (owner), whose email is always
// set. Without this, baker order/quote-accepted emails silently never send.
async function bakerNotifyEmail(baker) {
  if (baker?.email) return baker.email;
  if (!baker?.id) return null;
  const { data } = await supabase
    .from('baker_appusers')
    .select('email')
    .eq('baker_id', baker.id)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.email ?? null;
}

export async function notifyOrderPlaced({ order, baker, customer }) {
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const payload = {
    customerName,
    customerFirstName: customer.first_name,
    customerEmail:     customer.email,
    customerPhone:     customer.phone,
    bakerName:         baker.name,
    deliveryDate:      order.delivery_date,
    deliveryTime:      order.delivery_time,
    deliveryMode:      order.delivery_mode,
    deliveryAddress:   order.delivery_address,
    weightKg:          order.weight_kg,
    flavours:          order.flavours,
    specialInstructions: order.special_instructions,
    thumbnailUrl:      order.design_thumbnail_url ?? null,
  };

  const jobs = [];

  const bakerEmail = await bakerNotifyEmail(baker);
  if (bakerEmail) {
    jobs.push(insertNotification('order_placed_baker', bakerEmail, payload));
  }
  if (customer.email) {
    jobs.push(insertNotification('order_placed_customer', customer.email, payload));
  }

  await Promise.all(jobs);
}

// Baker edited the design while it's still open (shared-pen window). Email the
// customer that there are recommendations / an update to review. `mode` tunes the
// copy: 'recommendations' (initiated) vs 'updated' (quoted, i.e. after a quote).
export async function notifyDesignUpdated({ order, baker, customer, mode = 'updated' }) {
  if (!customer?.email) return;
  await insertNotification('design_updated_customer', customer.email, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    mode,                                   // 'recommendations' | 'updated'
    thumbnailUrl:      order.design_thumbnail_url ?? null,
  });
}

// Baker issued a quote. Email the customer the price + a link to review/accept it.
export async function notifyQuoteIssued({ order, baker, customer }) {
  if (!customer?.email) return;
  await insertNotification('quote_issued_customer', customer.email, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    quotedPrice:       order.quoted_price ?? null,
    quoteValidUntil:   order.quote_valid_until ?? null,
  });
}

// Customer accepted the quote → order confirmed. Email the baker.
export async function notifyQuoteAccepted({ order, baker, customer }) {
  const bakerEmail = await bakerNotifyEmail(baker);
  if (!bakerEmail) return;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  await insertNotification('quote_accepted_baker', bakerEmail, {
    customerName,
    orderId:    order.id,
    finalPrice: order.final_price ?? order.quoted_price ?? null,
  });
}
