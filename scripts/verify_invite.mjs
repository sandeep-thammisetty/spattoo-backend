// E2E test for POST /api/baker/customers/invite against the local API.
// Creates a throwaway baker-owner, sends an invite, verifies the row + link,
// then cleans up everything. Throwaway (not committed).
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_KEY, ANON = process.env.ANON_KEY;
const API = 'http://localhost:3000';
const OWNER_EMAIL = 'owner-invite-test@spattoo.local', PASS = 'TestOwner1!xyz';
const INVITEE_EMAIL = 'invitee-test@spattoo.local';
const sb = createClient(URL, SERVICE), anon = createClient(URL, ANON);

let ok = 0, bad = 0;
const check = (label, cond, extra='') => { console.log(`  ${cond?'✔':'✘'} ${label}${extra?': '+extra:''}`); cond?ok++:bad++; };

// Pick a baker
const { data: baker } = await sb.from('bakers').select('id, slug, name').eq('slug', 'feelings-flavours').single();

// Throwaway owner
await sb.auth.admin.deleteUser((await sb.auth.admin.listUsers()).data.users.find(u=>u.email===OWNER_EMAIL)?.id ?? '0').catch(()=>{});
const { data: created } = await sb.auth.admin.createUser({ email: OWNER_EMAIL, password: PASS, email_confirm: true });
const ownerUid = created.user.id;
await sb.from('baker_appusers').insert({ baker_id: baker.id, auth_user_id: ownerUid, role: 'owner', first_name: 'Test', last_name: 'Owner', email: OWNER_EMAIL });
const { data: signin } = await anon.auth.signInWithPassword({ email: OWNER_EMAIL, password: PASS });
const token = signin.session.access_token;

let inviteId, customerId;
try {
  const res = await fetch(`${API}/api/baker/customers/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Invitee', email: INVITEE_EMAIL, note: 'birthday cake', expiresInDays: 7 }),
  });
  const body = await res.json();
  console.log('\nPOST /baker/customers/invite →', res.status);
  console.log(JSON.stringify(body, null, 2));

  check('status 201', res.status === 201);
  check('returned customer_id', !!body.customer_id);
  check('returned invite.id', !!body.invite?.id);
  check('link contains slug + invite id', body.link?.includes(baker.slug) && body.link?.includes(body.invite?.id), body.link);
  check('channels include email', body.invite?.channels?.includes('email'));
  check('expires_at set', !!body.invite?.expires_at);

  inviteId = body.invite?.id; customerId = body.customer_id;

  // Verify rows in DB
  const { data: inv } = await sb.from('customer_invites').select('id, baker_id, customer_id, status, note, created_by').eq('id', inviteId).maybeSingle();
  check('invite row persisted', !!inv);
  check('invite.baker_id correct', inv?.baker_id === baker.id);
  check('invite.note persisted', inv?.note === 'birthday cake');
  check('invite.created_by set (audit)', !!inv?.created_by);

  // Re-invite same contact → reuses customer, new invite row
  const res2 = await fetch(`${API}/api/baker/customers/invite`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Invitee', email: INVITEE_EMAIL }),
  });
  const body2 = await res2.json();
  check('re-invite reuses same customer', body2.customer_id === customerId);
  check('re-invite mints a NEW invite id', body2.invite?.id && body2.invite.id !== inviteId);

  // cleanup the 2nd invite too
  if (body2.invite?.id) await sb.from('customer_invites').delete().eq('id', body2.invite.id);
} finally {
  if (customerId) {
    await sb.from('customer_invites').delete().eq('customer_id', customerId);
    await sb.from('customers').delete().eq('id', customerId);
  }
  await sb.from('baker_appusers').delete().eq('auth_user_id', ownerUid);
  await sb.auth.admin.deleteUser(ownerUid);
  console.log('\ncleaned up throwaway owner + test customer/invites.');
}
console.log(`\n${bad===0?'✔ ALL PASS':'✘ '+bad+' FAILED'} (${ok}/${ok+bad})`);
process.exit(bad===0?0:1);
