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

- [x] **SEC-0a — Path-boundary admin guard. ✅ DONE.** `src/server.js` mounts
  `app.use('/api/admin', requireAuth, requireAdmin)` before the routers; `requireAdmin`
  (`src/middleware/rbac.js`) requires an INTERNAL admin principal (a row in `admins`, via an `isAdmin`
  flag — not merely an admin capability). Every `/api/admin/*` route is now gated at the boundary.
  Per-route `requireCapability(...)` still applies on top. **This also closes SEC-1 and SEC-11.**
- [x] **SEC-0b — Regression guard. ✅ DONE.** `scripts/check-admin-routes.mjs` (`npm run check:admin-routes`,
  also in `npm run check`) fails if any admin-capability route sits outside `/api/admin`, or if the
  boundary middleware is missing. Audit result: all privileged routes are under `/admin` **except**
  `POST /jobs/extract` (`jobs.js`), which is documented-exempt (still protected by its per-route
  `catalog:admin` cap) — see follow-up below.
- [ ] **SEC-0c — (Later, at productionization) separate deploy target.** Split a second entry point
  `admin-server.js` (admin routers + `requireAdmin` only) from the same repo, deployed as a separate
  Render service on a **non-public host** (admin app / VPN / IP-allowlist). The public service never
  mounts the admin routers → admin endpoints become network-unreachable from baker/customer traffic.
  Same codebase, shared `src/services`; strongest isolation.

---

## 🔴 Critical

- [x] **SEC-1 — `/api/admin/patterns` has no authorization. ✅ CLOSED by SEC-0a.**
  `src/routes/patterns.js:30, 64` — these were `requireAuth`-only. They now sit behind the
  `/api/admin` boundary (`requireAdmin`), so non-admins get 403. Exposure closed. _(Optional
  defense-in-depth: add `requireCapability('catalog:admin')` per-route for consistency with siblings.)_

---

## 🟠 High

- [x] **SEC-2 — `/api/storage/delete` cross-tenant object deletion (IDOR). ✅ DONE.**
  Was gated by `design:create` (bakers + customers) with no ownership check, so any baker could delete
  another tenant's publicly-discoverable logo/gallery keys. **Fix (`src/routes/storage.js`):** changed
  the guard to **`requireAdmin`**. Its only real caller is the admin catalog UI (`ManageElements`);
  baker/customer asset deletion already goes through owner-scoped endpoints
  (`DELETE /baker/storefront-photos/:id`, order-photo deletes), so nothing baker-facing breaks. Bakers/
  customers can no longer reach this route → IDOR closed. (Chose admin-gating over per-row ownership
  checks because there is no legitimate baker/customer caller.)

- [x] **SEC-3 — Unescaped user data in transactional emails (stored, cross-tenant injection). ✅ DONE.**
  Customer/baker-controlled fields (names, address, `special_instructions`, quote "talk to baker"
  message, quote note, and URLs into `src=`/`href=`) were interpolated into email HTML **without
  escaping** (an `esc()` helper existed but was used only for the invite template). A customer could
  inject HTML into the baker's inbox (and vice-versa): in-brand phishing links, layout/CSS hijack,
  tracking pixels. **Fix:**
  - `src/jobs/processors/sendNotification.js` — every interpolated value in `orderDetailsHtml` + all
    `buildEmail` branches now runs through `esc()`. Added `escUrl()` (escapes **and** allowlists the
    scheme — only absolute `http(s)` passes) for every `href`/`src` (thumbnail, photos, storefront/quote
    links), so `javascript:`/`data:` can't be injected. Subjects left as plain text (nodemailer encodes
    headers; escaping would show literal entities).
  - `src/services/email.js` — the unescaped `sendOrderEmails`/`orderDetailsHtml` were **dead code**
    (superseded by the notifications outbox; nothing imported them) → removed (also drops a DRY
    duplicate). The one live export, `sendStaffWelcomeEmail`, now `esc()`s the staff name + bakery name.

- [x] **SEC-4 — No rate limiting anywhere (abuse / brute-force / enumeration). ✅ DONE.**
  Was: no limiter on any route → OTP spam/cost, no verify attempt cap, phone-enumeration oracle,
  trial-farming. **Fix:** added a reusable Redis-backed fixed-window limiter
  (`src/middleware/rateLimit.js` — one factory, applied per-route; atomic incr+expire via Lua;
  **fails open** on Redis error so it can never take the site down) and set `trust proxy: 1` in
  `server.js` so `req.ip` is the real client behind Render's proxy. Applied:
  - `POST /invite/:id/send-otp` → 5 / 10 min **per invite** + 30 / 10 min per IP (keyed on the invite
    id = the real abuse unit, so it holds behind shared IPs and can't be dodged by rotating IPs).
  - `POST /invite/:id/verify-otp` → 10 / 10 min per invite (brute-force cap).
  - `GET /bakers/slug-available`, `GET /bakers/phone-available` → 120 / min per IP (generous vs. the
    debounced typing use; stops mass enumeration).
  - `POST /bakers/self` → 10 / hour per user (anti trial-farming; idempotent anyway).
  Limits are well above real usage → no legitimate flow breaks. Behaviour unit-verified (under-limit
  passes, over-limit → 429 + `Retry-After`, per-key isolation, null-key skip, Redis-error fail-open).
  _(Not covered, optional follow-up: `POST /baker/customers/invite` is authed + capability-gated but
  sends emails — could get a per-baker cap later.)_

---

## 🟡 Medium

- [x] **SEC-5 — R2 signed-upload: keys not tenant-scoped + no content-type allowlist. ✅ DONE.**
  Was: key = `folder/filename` (client-controlled, no random id → overwrite another tenant's asset;
  predictable) and `contentType` unvalidated → upload `text/html` / `image/svg+xml` to the public
  bucket and get a stable URL that executes script on the asset origin (stored XSS / phishing hosting).
  **Fix (`src/routes/storage.js`):**
  - **MIME allowlist per folder** — single-source `FOLDER_CONTENT_TYPES` map (image folders = raster
    only, **SVG deliberately excluded**; model folders = GLB/binary); `ALLOWED_FOLDERS` is now *derived*
    from it (DRY, can't drift). `text/html`/`image/svg+xml` are rejected with 400.
  - **Server-derived keys** — `folder/<randomUUID()>.<ext>`; the client filename contributes only a
    sanitised extension. No client can overwrite (UUID collision ≈ 0) or predict/enumerate keys.
    Transparent to callers — grep confirmed all upload sites (admin, core, web) use the *returned*
    `key`/`publicUrl`, never the name they sent.
  - Extension logic unit-checked (case-fold, multi-dot, missing-ext fallback, over-long reject).
  _(Path traversal via `../` was never exploitable — R2 keys are opaque; now moot anyway since the key
  is server-generated.) Chose a random UUID over a `<bakerId>` prefix because the route is also used by
  admin (no baker) and customers; the UUID closes the overwrite/predictability vuln without needing to
  resolve a tenant. **Deeper hardening (future):** `Content-Disposition: attachment` on user-uploaded
  public objects, or serve them from a sandboxed asset origin — defense-in-depth beyond the MIME gate.)_

- [x] **SEC-6 — Paid-plan self-activation fails *open* if Razorpay keys are unset. ✅ DONE.**
  Was: when `razorpayEnabled()` is false, `POST /billing/subscribe` activated any requested tier with
  **no charge** (gated only by env-var presence) — so if the prod key were ever missing/rotated out,
  any baker could self-grant Blaze/Forge at ₹0. **Fix (`src/routes/billing.js`):** the no-keys fallback
  now **fails closed** — it activates only when `ALLOW_FREE_PLAN_SELECT === 'true'` (the same explicit
  per-environment dev flag `/baker/plan/select` uses — set on the dev API, never prod; reused, not a new
  flag). Otherwise it returns 503 and logs the misconfiguration. In prod (flag off + keys on) real
  bakers always take the Razorpay branch, so the free-grant path is unreachable; the fallback is purely
  a dev affordance. Downgrade-to-free is unaffected (that's `/billing/cancel` / `/baker/plan/select`, not
  this no-charge path). No legitimate flow breaks (signup defaults to Spark via `createBakerForUser`, not
  this endpoint).

- [x] **SEC-7 — Cross-tenant reads of private catalog data. ✅ DONE.**
  Was: `GET /templates/:id` had no `baker_id` filter (the list route did) → a baker could read another
  baker's private template by id; `GET /elements` (both branches) had none → would leak baker-private
  elements once the per-baker library exists (latent). **Fix:** new shared helper
  `src/lib/tenantScope.js → scopeCatalogRead(query, req)` applies `baker_id IS NULL OR baker_id =
  <caller's tenant>` (admins bypass; no-tenant callers get global only), keyed on the **server-resolved**
  `req.bakerId` (never a client value → not injection-prone). Applied to `GET /templates/:id` and both
  branches of `GET /elements`. A template owned by another baker now returns **404** (same as a
  nonexistent id → no enumeration leak). Kept as ONE helper rather than pasted per route — the exact
  duplication class that let this exist (list routes scoped, by-id routes not); this is a down payment
  on SEC-14. Branch behaviour unit-verified (baker/customer → own+global, no-tenant → global, admin →
  unrestricted).

- [x] **SEC-8 — Wide-open CORS. ✅ DONE.**
  Was: `app.use(cors())` reflected `*` → any site could script the API from a browser (not ATO — Bearer
  auth, no cookies — but a removed defense layer that amplified SEC-4). **Fix:** `app.use(cors(corsOptions()))`
  with a config-derived allowlist (`src/lib/cors.js` + `config.cors`):
  - Allowed = apex + **any subdomain** of `baseDomain` over **https** (one wildcard rule → every
    `{slug}.<base>` storefront + `app`/marketing hosts; **O(1) in tenants**, no per-baker list). Leading-dot
    match blocks suffix spoofing (`evil-spattoo.com`, `spattoo.com.attacker.com`).
  - `baseDomain` auto-derives from `STOREFRONT_URL_TEMPLATE` (override: `CORS_BASE_DOMAIN`).
  - Requests with **no Origin** (curl/server-to-server/native webview/same-origin) allowed — CORS only
    governs cross-origin browser calls, and browsers set Origin honestly.
  - `CORS_ALLOW_LOCALHOST` (default on → keeps local dev + the local admin tool working; set `=false`
    to harden prod) and `CORS_ALLOWED_ORIGINS` (comma list) for one-off exacts.
  - Baker custom domains (deferred) will add a DB-verified dynamic branch here, not a wildcard.
  Allowlist unit-verified (15 cases: apex/www/app/{slug} pass; attacker + suffix-spoof + non-https +
  garbage fail; localhost gated by env). **Env to set:** dev Render `STOREFRONT_URL_TEMPLATE` →
  `https://{slug}.spattoo.dev` (or `CORS_BASE_DOMAIN=spattoo.dev`); prod → set `CORS_ALLOW_LOCALHOST=false`.

- [x] **SEC-9 — Raw internal error messages leaked to clients. ✅ DONE.**
  Was: **228** route sites (far more than the "~20" first estimate) did `res.status(500).json({ error:
  err.message })` (catch blocks) or `if (error) return res.status(500).json({ error: error.message })`
  (inline Supabase errors), bypassing `middleware/errorHandler.js` — leaking Postgres/Supabase messages,
  constraint/column/internal detail, and also skipping telemetry + `request_id`. **Fix:** new shared
  `src/lib/httpError.js → serverError(req, res, err)` that mirrors the central handler (logs to
  telemetry, returns `{ error: 'Internal server error', request_id }` — never the raw message). Routes
  keep their `(req, res)` signature (no `next` retrofit needed). Every 500 site across all 20 route files
  now routes through it (mechanical sweep; `rbac.js` `_req`→`req` + a unique-violation 409 given a clean
  message; two template-literal 500s handled). **4xx validation messages kept as-is** (safe + useful).
  Verified: all route files parse, `npm run check` green, zero remaining `status(500)…​.message` leaks,
  and a live check confirms the raw message is logged server-side but the client body is masked +
  carries `request_id`.

- [x] **SEC-10 — PostgREST `.or()` filter injection from user input. ✅ DONE.**
  Was: `.or()` filters built by string-interpolating user-controlled values, so crafted `,`/`)`/`.`
  could alter the match. **Fix — converted every user-value filter off string-built `.or()`:**
  - `src/services/bakerProvisioning.js` (`findAppuserByIdentity`, the owner-uniqueness check) → two
    parameterised `.eq` lookups (phone-first, preserving `matchedOn` semantics); supabase-js encodes
    `.eq` values so injection is impossible.
  - `src/middleware/rbac.js` (`resolveCustomer`, customer login match — same class, not in the original
    finding) → two `.eq` lookups merged + de-duped (preserves "email OR phone").
  - `src/routes/templates.js` (admin `?baker_id`) → `Number.parseInt` coercion; non-integer → ignored
    (admin sees all). `parseInt('5)inject') → 5`, so trailing syntax is dropped.
  Remaining `.or()` interpolations use only the **server-resolved** `req.bakerId` (an int) — not user
  input — so they're safe (documented in `lib/tenantScope.js`). Coercion verified.

---

## 🟢 Low

- [x] **SEC-11 — Admin config readable by any authenticated user. ✅ CLOSED by SEC-0a.**
  `GET /admin/entitlements-schema` (`src/routes/subscriptions.js:57`) and `GET /admin/subscription-plans`
  (`:86`) were `requireAuth`-only; now behind the `/api/admin` boundary (`requireAdmin`).
- [ ] **SEC-12 — Debug endpoints shipped.** `GET /billing/debug-me`, `GET /billing/ping`
  (`src/routes/billing.js:84, 87`). **Fix:** remove or env-gate.
- [ ] **SEC-13 — Data bug (not security).** `src/routes/jobs.js:19` writes an auth-user UUID into the
  `baker_id` column. **Fix:** write the resolved `baker_id`.
- [ ] **SEC-16 — Front-end URL-scheme sink (`href` without allowlist).** _(spattoo-core / spattoo-web,
  not the API — logged here to keep one security ledger.)_ The React apps auto-escape all HTML bodies
  (JSX; **no** `dangerouslySetInnerHTML`/`innerHTML` anywhere), so the SEC-3 stored-XSS class does **not**
  exist outside email. The one residual gap is URL **schemes**: `spattoo-core/src/storefront/
  CustomerStorefront.jsx:475` binds a baker-controlled `baker.website_url` to `href` with no scheme
  check (React escapes the string but does not block `javascript:`), and the config-driven nav
  `n.href` (`:243`, `:265`) is the same pattern if those hrefs are baker/admin-authored. Low severity
  (baker-controlled → mostly self-XSS on the baker's own public storefront). Safe hardcoded-scheme
  links (`tel:`/`wa.me/`/`instagram.com/`) are fine. **Fix:** a shared `safeHref(url)` helper
  (https-only allowlist — the front-end analog of email's `escUrl`) at every stored-URL `href`, **and**
  validate the scheme when the baker saves `website_url` (defense at the write-point too).

---

## Architectural follow-up
- [ ] **SEC-15 — Relocate `POST /jobs/extract` under `/api/admin`.** It's an admin-only job
  (`catalog:admin`) but sits outside `/admin`, so the boundary can't backstop it (currently exempt in
  `check-admin-routes.mjs`; still protected by its per-route cap). Rename to `/admin/jobs/extract` and
  update the `spattoo-admin` client call, then remove it from the check's `EXEMPT` set.
- [ ] **SEC-14 — Shared `assertBakerOwns(table, id)` helper.** The "look up `baker_id` from the token,
  then `.eq('baker_id', …)`" pattern is duplicated ~30×; that duplication is where SEC-2/SEC-7 slipped in.
  One shared helper both reduces risk and matches the project-wide DRY/reuse invariant (root `CLAUDE.md`).
- [ ] **SEC-17 — Edge / DDoS protection (infra layer). 🗓️ FUTURE — not addressed now.** SEC-4's app-level
  rate limiting is a per-actor **abuse/cost/fraud** control, NOT DDoS defense: the limiter runs *inside*
  Node (after TCP/TLS + parse + a Redis round-trip, then returns 429), so a flood still burns compute /
  connections / bandwidth / Redis ops; L3–L4 volumetric floods never reach the app at all; distributed
  many-IP floods slip under per-IP caps; and the limiter **fails open** if Redis saturates. DDoS must be
  mitigated at the **edge, before traffic reaches origin**: proxy the API hostname through **Cloudflare**
  (already used for R2) and enable WAF + L3/4 mitigation + bot management + edge rate-limit rules +
  challenge pages; keep origin hygiene (the existing 5 MB body cap + sane request timeouts). Complementary
  layer to SEC-4, not covered by it. **Deferred to a future infra/hardening pass (pre-scale-up), not part
  of the current app-code security sweep.**

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
