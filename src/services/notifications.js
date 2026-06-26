import { supabase } from './supabase.js';

async function getTypeId(slug) {
  const { data } = await supabase
    .from('notification_types')
    .select('id')
    .eq('slug', slug)
    .single();
  return data?.id;
}

async function insertNotification(typeSlug, recipientEmail, payload) {
  const typeId = await getTypeId(typeSlug);
  if (!typeId) throw new Error(`Unknown notification type: ${typeSlug}`);

  const { error } = await supabase
    .from('notifications')
    .insert({ type_id: typeId, recipient_email: recipientEmail, payload });

  if (error) throw new Error(`Failed to insert notification: ${error.message}`);
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

  if (baker.email) {
    jobs.push(insertNotification('order_placed_baker', baker.email, payload));
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
