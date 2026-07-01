# spattoo-api — Security Action Plan

_Review date: 2026-07-01. Method: full-codebase audit (read-only) across three threat classes —
(a) auth & multi-tenant isolation/IDOR, (b) injection / uploads / SSRF / email output, (c) secrets /
webhooks / payments / CORS / rate-limiting / error leakage._

**Risk model:** the API runs on the Supabase **service key**, which bypasses Row-Level Security — so
**app-level authorization is the only tenant boundary.** That boundary is generally enforced well and
consistently; the items below are the specific deviations. Work top-down; each item is self-contained
(check it off when done).

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low.

---

## 0. Foundational — scope the admin surface as a boundary (do first)

The recurring root cause is that **privileged `/api/admin/*` routes rely on per-route guards** (easy to
forget — see SEC-1, SEC-11). The RBAC model is sound: a separate `admins` table with `role ∈
{admin, admin_staff}` (`is_super`), resolved before bakers/customers, deny-by-default
(`src/middleware/rbac.js:15`). The gap is routing, not identity. Turn privilege into a boundary:

- [ ] **SEC-0a — Path-boundary admin guard.** In `src/server.js`, **before** the `app.use('/api', …router)`
  lines, add `app.use('/api/admin', requireAuth, requireAdmin)` where `requireAdmin` asserts the
  principal is `admin`/`admin_staff` (403 otherwise). Express matches by prefix, so **every current and
  future `/api/admin/*` route is gated at the boundary — impossible to forget.** Keep per-route
  `requireCapability(...)` on top for granularity. (This alone closes SEC-1 and SEC-11.)
- [ ] **SEC-0b — Regression guard.** Add a boot assertion / `check` script (like `check:schema`) that
  fails if any privileged handler is registered **outside** `/api/admin`, or if the boundary middleware
  is missing. First audit that all privileged routes actually use the `/api/admin` prefix.
- [ ] **SEC-0c — (Later, at productionization) separate deploy target.** Split a second entry point
  `admin-server.js` (admin routers + `requireAdmin` only) from the same repo, deployed as a separate
  Render service on a **non-public host** (admin app / VPN / IP-allowlist). The public service never
  mounts the admin routers → admin endpoints become network-unreachable from baker/customer traffic.
  Same codebase, shared `src/services`; strongest isolation.

---

## 🔴 Critical

- [ ] **SEC-1 — `/api/admin/patterns` has no authorization.**
  `src/routes/patterns.js:30, 64` — `POST` and `DELETE /api/admin/patterns/:slug` are gated by
  `requireAuth` **only** (no capability). Any authenticated principal — a rival baker, staff, or an
  invited **customer** — can delete/inject **global** pattern master data every tenant depends on (a
  service-key write).
  **Fix:** add `requireCapability('catalog:admin')` to both routes (SEC-0a would also cover this at the
  boundary).

---

## 🟠 High

- [ ] **SEC-2 — `/api/storage/delete` cross-tenant object deletion (IDOR).**
  `src/routes/storage.js:58` — accepts an arbitrary R2 `key`, checks only that it's under a managed
  folder, never that it belongs to the caller (cap `design:create`, held by bakers **and** customers).
  Gallery/logo keys are publicly discoverable via `GET /api/storefront/:slug`, so baker A can delete
  competitor B's logo/gallery objects (DB rows survive → broken images on B's live site).
  **Fix:** only allow deleting keys that match a row the caller owns (`baker_storefront_photos`,
  `order_finished_photos`, …); reject any other key.

- [ ] **SEC-3 — Unescaped user data in transactional emails (stored, cross-tenant injection).**
  `src/jobs/processors/sendNotification.js`, `src/services/email.js` — customer/baker-controlled fields
  (names, address, `special_instructions`, quote "talk to baker" message, and URLs into `src=`/`href=`)
  are interpolated into email HTML **without escaping**, though an `esc()` helper exists in
  `sendNotification.js:17` (used only for the invite template). A customer injects HTML into the baker's
  inbox (and vice-versa): in-brand phishing links, layout/CSS hijack, tracking pixels.
  **Fix:** run every interpolated value through `esc()` in `orderDetailsHtml` + all `buildEmail`
  branches and in `email.js`; for URL attributes, escape **and** allowlist the scheme
  (`https:`/bucket origin) so `javascript:`/`data:` can't be injected.

- [ ] **SEC-4 — No rate limiting anywhere (abuse / brute-force / enumeration).**
  No limiter on any route. `POST /api/invite/:id/send-otp` (public) → SMS/email OTP spam + cost;
  `verify-otp` has no app-level attempt cap; `GET /api/bakers/phone-available` is a phone-enumeration
  oracle; `/bakers/self` enables trial-farming.
  **Fix:** add a Redis-backed limiter (Redis already present) — tight per-IP/per-key caps on the OTP
  endpoints, signup, and the `-available` endpoints; add a per-invite verify-attempt lockout.

---

## 🟡 Medium

- [ ] **SEC-5 — R2 signed-upload: keys not tenant-scoped + no content-type allowlist.**
  `src/routes/storage.js:25-41` — key = `folder/filename` with no baker prefix / no server-enforced
  random id → overwrite another tenant's asset; `contentType` unvalidated → upload `text/html` /
  `image/svg+xml` to a public folder and get a stable URL that executes script on the asset origin.
  **Fix:** derive keys server-side as `folder/<bakerId>/<uuid>.<ext>`; allowlist MIME per folder; set a
  restrictive `Content-Type`/`Content-Disposition` on user-uploaded public objects (or serve from a
  sandboxed origin). _(Path traversal via `../` is NOT exploitable — R2 keys are opaque.)_

- [ ] **SEC-6 — Paid-plan self-activation fails *open* if Razorpay keys are unset.**
  `src/routes/billing.js:204-239` — when `razorpayEnabled()` is false, `POST /billing/subscribe`
  activates any requested paid tier with **no charge**. It's gated only by env-var presence; if the prod
  key is ever missing/rotated out, every baker can self-grant Blaze/Forge.
  **Fix:** gate the keyless fallback behind an explicit flag (like `ALLOW_FREE_PLAN_SELECT`, already used
  in `subscriptions.js:264`) so a missing key **fails closed**.

- [ ] **SEC-7 — Cross-tenant reads of private catalog data.**
  `GET /templates/:id` (`src/routes/templates.js:75`) has no `baker_id` filter (the list route does) →
  a baker can read another baker's private template by id. `GET /elements`
  (`src/routes/elements.js:163`) has no `baker_id` filter → will leak baker-private elements once the
  per-baker library exists (latent today).
  **Fix:** apply `baker_id IS NULL OR baker_id = <caller>` in both; 404 otherwise.

- [ ] **SEC-8 — Wide-open CORS.**
  `src/server.js:29` `app.use(cors())` reflects `*`. Not credentialed-CORS ATO (Bearer auth), but it lets
  any site script the full API (amplifies SEC-4).
  **Fix:** allowlist known origins (`app.spattoo.dev`, `*.spattoo.com`/`*.spattoo.dev`, admin) via
  `cors({ origin: fn })`.

- [ ] **SEC-9 — Raw internal error messages leaked to clients.**
  ~20 route catches `return res.status(500).json({ error: err.message })`, bypassing the safe
  `src/middleware/errorHandler.js` — leaking Supabase/Postgres messages, constraint/column names.
  **Fix:** `next(err)` to the central handler on 5xx (mask to generic + request id); keep 4xx validation
  messages.

- [ ] **SEC-10 — PostgREST `.or()` filter injection from user input.**
  `src/services/bakerProvisioning.js:60-63` builds `.or('phone.eq.${p},email.eq.${e}')` from signup input;
  crafted `,`/`.`/`)` can alter the owner-uniqueness match. Also `src/routes/templates.js:47` (`baker_id`
  query param interpolated).
  **Fix:** validate/normalize email + phone before building the filter (or use two `.eq` queries); coerce
  `baker_id` to an integer.

---

## 🟢 Low

- [ ] **SEC-11 — Admin config readable by any authenticated user.**
  `GET /admin/entitlements-schema` (`src/routes/subscriptions.js:57`) and `GET /admin/subscription-plans`
  (`:86`, `select('*')`) are `requireAuth`-only. **Fix:** gate with an admin capability (covered by
  SEC-0a).
- [ ] **SEC-12 — Debug endpoints shipped.** `GET /billing/debug-me`, `GET /billing/ping`
  (`src/routes/billing.js:84, 87`). **Fix:** remove or env-gate.
- [ ] **SEC-13 — Data bug (not security).** `src/routes/jobs.js:19` writes an auth-user UUID into the
  `baker_id` column. **Fix:** write the resolved `baker_id`.

---

## Architectural follow-up
- [ ] **SEC-14 — Shared `assertBakerOwns(table, id)` helper.** The "look up `baker_id` from the token,
  then `.eq('baker_id', …)`" pattern is duplicated ~30×; that duplication is where SEC-2/SEC-7 slipped in.
  One shared helper both reduces risk and matches the project-wide DRY/reuse invariant (root `CLAUDE.md`).

---

## ✅ Verified solid (no action — recorded for confidence)
- **Tenant isolation** is generally correct: routes resolve `baker_id` from the token and scope with
  `.eq('baker_id', …)`; order routes use ownership helpers; **no route trusts a client-supplied
  `baker_id`/`customer_id` for writes.**
- **Auth:** JWT verified via `supabase.auth.getUser()` (network validation, not local decode);
  deny-by-default principal resolution.
- **Razorpay webhook:** HMAC-SHA256 over the **raw** body, `timingSafeEqual`, idempotent, replay-safe;
  Meshy webhook re-fetches the authoritative task.
- **Payment integrity:** amount/plan from the server-side catalog; activation only on the verified
  webhook (except the SEC-6 fail-open).
- **Secrets:** none hardcoded; service key stays server-side; only the Razorpay *publishable* key id
  reaches the client.
- **No** SQL injection (parameterized), SSRF (server never fetches attacker URLs), `eval`/`child_process`,
  or ReDoS; request body size capped.
