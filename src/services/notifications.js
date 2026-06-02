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

async function enqueueNotification(typeSlug, recipientEmail, payload) {
  const typeId = await getTypeId(typeSlug);
  if (!typeId) throw new Error(`Unknown notification type: ${typeSlug}`);

  const { data, error } = await supabase
    .from('notifications')
    .insert({ type_id: typeId, recipient_email: recipientEmail, payload })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert notification: ${error.message}`);

  await jobQueue.add('send_notification', { notificationId: data.id }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
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
  };

  const jobs = [];

  if (baker.email) {
    jobs.push(enqueueNotification('order_placed_baker', baker.email, payload));
  }
  if (customer.email) {
    jobs.push(enqueueNotification('order_placed_customer', customer.email, payload));
  }

  await Promise.all(jobs);
}
