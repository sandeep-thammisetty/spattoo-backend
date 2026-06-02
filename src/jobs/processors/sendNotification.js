import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { supabase } from '../../services/supabase.js';

const transporter = nodemailer.createTransport({
  host:   config.smtp.host,
  port:   config.smtp.port,
  secure: config.smtp.port === 465,
  auth: { user: config.smtp.user, pass: config.smtp.pass },
});

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function orderDetailsHtml(p) {
  const rows = [
    ['Customer',     p.customerName],
    p.customerEmail ? ['Email', p.customerEmail] : null,
    p.customerPhone ? ['Phone', p.customerPhone] : null,
    ['Delivery',     `${formatDate(p.deliveryDate)}${p.deliveryTime ? ' at ' + p.deliveryTime : ''}`],
    ['Mode',         p.deliveryMode === 'home_delivery' ? 'Home Delivery' : 'Pickup'],
    p.deliveryAddress ? ['Address', p.deliveryAddress] : null,
    p.weightKg ? ['Weight', `${p.weightKg} kg`] : null,
    p.flavours?.length ? ['Flavours', p.flavours.join(', ')] : null,
    p.specialInstructions ? ['Instructions', p.specialInstructions] : null,
  ].filter(Boolean);

  return `<table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#333">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding:6px 0;color:#888;width:160px">${label}</td>
        <td style="padding:6px 0">${value}</td>
      </tr>`).join('')}
  </table>`;
}

function buildEmail(typeSlug, recipientEmail, payload) {
  const p = payload;

  const thumbnailHtml = p.thumbnailUrl
    ? `<img src="${p.thumbnailUrl}" alt="Cake design" style="display:block;max-width:100%;border-radius:8px;margin:16px 0" />`
    : '';

  if (typeSlug === 'order_placed_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `New Order — ${p.customerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">New Order Received 🎂</h2>
        <p>You have a new cake order from <b>${p.customerName}</b>.</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px;color:#888;font-size:12px">Log in to your Spattoo dashboard to view and manage this order.</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_placed_customer') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Your cake order is confirmed! 🎂`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Order Confirmed!</h2>
        <p>Hi ${p.customerFirstName}, thank you for your order with <b>${p.bakerName}</b>. Here's a summary:</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px">We'll be in touch soon. If you have any questions, contact your baker directly.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  throw new Error(`Unknown notification type: ${typeSlug}`);
}

export async function sendNotification({ notificationId }) {
  // Fetch notification with its type
  const { data: notification, error } = await supabase
    .from('notifications')
    .select('*, notification_types(slug)')
    .eq('id', notificationId)
    .single();

  if (error || !notification) throw new Error(`Notification ${notificationId} not found`);

  const typeSlug = notification.notification_types.slug;
  const mail = buildEmail(typeSlug, notification.recipient_email, notification.payload);

  try {
    await transporter.sendMail(mail);
    await supabase.from('notifications').update({
      status:  'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', notificationId);
  } catch (err) {
    const exhausted = notification.attempts >= notification.max_attempts;
    await supabase.from('notifications').update({
      status:        exhausted ? 'failed' : 'pending',
      error_message: err.message,
      ...(exhausted ? { failed_at: new Date().toISOString() } : {}),
    }).eq('id', notificationId);
  }
}
