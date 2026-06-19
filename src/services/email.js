import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = nodemailer.createTransport({
  host:   config.smtp.host,
  port:   config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function orderDetailsHtml(order) {
  return `
    <table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#333">
      <tr><td style="padding:6px 0;color:#888;width:160px">Customer</td><td style="padding:6px 0"><b>${order.customerName}</b></td></tr>
      ${order.customerEmail ? `<tr><td style="padding:6px 0;color:#888">Email</td><td style="padding:6px 0">${order.customerEmail}</td></tr>` : ''}
      ${order.customerPhone ? `<tr><td style="padding:6px 0;color:#888">Phone</td><td style="padding:6px 0">${order.customerPhone}</td></tr>` : ''}
      <tr><td style="padding:6px 0;color:#888">Delivery</td><td style="padding:6px 0">${formatDate(order.deliveryDate)}${order.deliveryTime ? ' at ' + order.deliveryTime : ''}</td></tr>
      <tr><td style="padding:6px 0;color:#888">Mode</td><td style="padding:6px 0">${order.deliveryMode === 'home_delivery' ? 'Home Delivery' : 'Pickup'}</td></tr>
      ${order.deliveryAddress ? `<tr><td style="padding:6px 0;color:#888">Address</td><td style="padding:6px 0">${order.deliveryAddress}</td></tr>` : ''}
      ${order.weightKg ? `<tr><td style="padding:6px 0;color:#888">Weight</td><td style="padding:6px 0">${order.weightKg} kg</td></tr>` : ''}
      ${order.flavours?.length ? `<tr><td style="padding:6px 0;color:#888">Flavours</td><td style="padding:6px 0">${order.flavours.join(', ')}</td></tr>` : ''}
      ${order.specialInstructions ? `<tr><td style="padding:6px 0;color:#888">Instructions</td><td style="padding:6px 0">${order.specialInstructions}</td></tr>` : ''}
    </table>
  `;
}

export async function sendOrderEmails({ order, baker, customer }) {
  if (!config.smtp.host || !config.smtp.user) return;

  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const orderData = {
    customerName,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    deliveryDate:  order.delivery_date,
    deliveryTime:  order.delivery_time,
    deliveryMode:  order.delivery_mode,
    deliveryAddress: order.delivery_address,
    weightKg:      order.weight_kg,
    flavours:      order.flavours,
    specialInstructions: order.special_instructions,
  };

  const emails = [];

  // Email to baker
  if (baker.email) {
    emails.push(transporter.sendMail({
      from:    config.smtp.from,
      to:      baker.email,
      subject: `New Order — ${customerName}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#2C4433">New Order Received 🎂</h2>
          <p>You have a new cake order from <b>${customerName}</b>.</p>
          ${orderDetailsHtml(orderData)}
          <p style="margin-top:24px;color:#888;font-size:12px">Log in to your Spattoo dashboard to view and manage this order.</p>
        </div>
      `,
    }));
  }

  // Email to customer
  if (customer.email) {
    emails.push(transporter.sendMail({
      from:    config.smtp.from,
      to:      customer.email,
      subject: `Your cake order is confirmed! 🎂`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#2C4433">Order Confirmed!</h2>
          <p>Hi ${customer.first_name}, thank you for your order with <b>${baker.name}</b>. Here's a summary:</p>
          ${orderDetailsHtml(orderData)}
          <p style="margin-top:24px">We'll be in touch soon. If you have any questions, reply to this email or contact your baker directly.</p>
          <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
        </div>
      `,
    }));
  }

  await Promise.allSettled(emails);
}
