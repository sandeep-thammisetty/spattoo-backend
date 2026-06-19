// E2E: customer auth gate. Simulates an OTP-verified customer (password signin
// stands in for the verified session) and checks invite-gated access. Cleans up.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_KEY, ANON = process.env.ANON_KEY;
const API = 'http://localhost:3000';
const EMAIL = 'cust-otp-test@spattoo.local', PASS = 'TestCust1!xyz';
const sb = createClient(URL, SERVICE), anon = createClient(URL, ANON);

let ok = 0, bad = 0;
const check = (l, c, x='') => { console.log(`  ${c?'✔':'✘'} ${l}${x?': '+x:''}`); c?ok++:bad++; };
const status = async (path, token) => (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const me = async (token) => (await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json();

const { data: baker } = await sb.from('bakers').select('id, slug').eq('slug', 'feelings-flavours').single();

// Throwaway customer + valid invite + auth user with matching email
await sb.from('customers').delete().eq('email', EMAIL);
await sb.auth.admin.deleteUser((await sb.auth.admin.listUsers()).data.users.find(u=>u.email===EMAIL)?.id ?? '0').catch(()=>{});
const { data: cust } = await sb.from('customers').insert({ baker_id: baker.id, first_name: 'Otp', email: EMAIL, source: 'invite', is_active: true }).select('id').single();
const { data: invite } = await sb.from('customer_invites').insert({ baker_id: baker.id, customer_id: cust.id, channels: ['email'], status: 'sent', expires_at: new Date(Date.now()+7*86400000).toISOString() }).select('id').single();
const { data: created } = await sb.auth.admin.createUser({ email: EMAIL, password: PASS, email_confirm: true });
const uid = created.user.id;
const { data: signin } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASS });
const token = signin.session.access_token;

try {
  console.log('\nPhase A — valid invite present:');
  const m = await me(token);
  check('role = customer', m.role === 'customer', m.role);
  check('bakerId = invited baker', m.bakerId === baker.id);
  check('customerId resolved', m.customerId === cust.id);
  check('caps = design:create + order:place', JSON.stringify(m.capabilities) === JSON.stringify(['design:create','order:place']), JSON.stringify(m.capabilities));
  check('GET /api/elements (design:create) → 200', await status('/api/elements', token) === 200);
  check('GET /api/baker/customers (customer:manage) → 403', await status('/api/baker/customers', token) === 403);

  console.log('\nPublic invite landing:');
  const land = await (await fetch(`${API}/api/invite/${invite.id}`)).json();
  check('valid = true', land.valid === true);
  check('baker branding present', !!land.baker?.slug);
  check('email masked (not raw)', land.customer?.masked_email && !land.customer.masked_email.includes('cust-otp-test'), land.customer?.masked_email);

  console.log('\nPhase B — invite expired (gate closes):');
  await sb.from('customer_invites').update({ expires_at: new Date(Date.now()-86400000).toISOString() }).eq('id', invite.id);
  const m2 = await me(token);
  check('role = null (no valid invite)', m2.role === null, String(m2.role));
  check('GET /api/elements → 403 (blocked)', await status('/api/elements', token) === 403);
} finally {
  await sb.from('customer_invites').delete().eq('id', invite.id);
  await sb.from('customers').delete().eq('id', cust.id);
  await sb.auth.admin.deleteUser(uid);
  console.log('\ncleaned up.');
}
console.log(`\n${bad===0?'✔ ALL PASS':'✘ '+bad+' FAILED'} (${ok}/${ok+bad})`);
process.exit(bad===0?0:1);
