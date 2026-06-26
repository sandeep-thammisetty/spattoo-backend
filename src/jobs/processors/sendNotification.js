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
    p.flavours?.length ? ['Flavours', p.flavours.map(f => f.name ?? f.flavour ?? f).join(', ')] : null,
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

function rawEmail(from) {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
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
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your cake order is confirmed!`,
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

  if (typeSlug === 'design_updated_customer') {
    const isReco = p.mode === 'recommendations';
    const link = p.bakerSlug
      ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug)
      : null;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: isReco
        ? `${p.bakerName} has design ideas for your cake`
        : `${p.bakerName} updated your cake design`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">${isReco ? 'A few ideas for your cake 🎨' : 'Your design was updated 🎂'}</h2>
        <p>Hi ${p.customerFirstName}, <b>${p.bakerName}</b> ${isReco
          ? 'has suggested some changes to your cake design'
          : 'has updated your cake design'}. Open the designer to take a look — you can keep refining it yourself.</p>
        ${thumbnailHtml}
        ${link ? `<p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">View your design</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_issued_customer') {
    const link = p.bakerSlug
      ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug)
      : null;
    const priceLine = p.quotedPrice != null ? `Your quote: <b>₹${p.quotedPrice}</b>` : "Your quote is ready";
    const validLine = p.quoteValidUntil
      ? `<p style="color:#888;font-size:13px">Valid until ${formatDate(p.quoteValidUntil)}.</p>`
      : "";
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `${p.bakerName} sent you a quote`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your quote is ready 🎂</h2>
        <p>Hi ${p.customerFirstName}, <b>${p.bakerName}</b> has priced your cake.</p>
        <p style="font-size:16px">${priceLine}</p>
        ${validLine}
        ${link ? `<p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">Review your quote</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_accepted_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Quote accepted — ${p.customerName || 'a customer'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Quote accepted ✅</h2>
        <p><b>${p.customerName || 'A customer'}</b> accepted your quote${p.finalPrice != null ? ` of <b>₹${p.finalPrice}</b>` : ''}. The order is now confirmed.</p>
        <p style="margin-top:24px;color:#888;font-size:12px">Open your Spattoo dashboard to start production.</p>
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
