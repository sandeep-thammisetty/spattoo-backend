// Entitlement registry — DEFINITIONS only (plan-agnostic). The actual per-plan
// VALUES live as data on the plan row (subscription_plans.features jsonb), so the
// resolver never branches on plan name/rank and renaming/restructuring plans needs
// no code change. `fallback` is the conservative value used when a plan hasn't set
// a key yet, and the value an inactive subscription collapses to.
//   bool → false (locked) | int → a safe floor (0 = none, 1 = the minimum)
// null in a plan's features means "unlimited" for an int key (see resolver).
export const ENTITLEMENTS = {
  // booleans
  storefront:             { type: 'bool', fallback: false }, // public {slug}.spattoo.com — now ON for all tiers
  custom_branding:        { type: 'bool', fallback: false }, // logo/colors/story — now ON for all tiers
  custom_templates:       { type: 'bool', fallback: false }, // DEPRECATED — superseded by max_saved_templates (count). Inert; remove when the count-gate is wired.
  ai_background_removal:  { type: 'bool', fallback: false },
  whatsapp_notifications: { type: 'bool', fallback: false }, // DEFERRED (#20) — off all tiers; inert (read nowhere yet)
  xray_reports:           { type: 'bool', fallback: false },
  // numeric limits — null (in a plan's features) = unlimited
  max_orders_total:       { type: 'int',  fallback: 0 }, // LIFETIME order cap; null = unlimited. ALL tiers null — Spark is gated by the 30-day TRIAL window (status), not an order count.
  max_team_members:       { type: 'int',  fallback: 1 },
  max_saved_templates:    { type: 'int',  fallback: 0 }, // custom baker-saved templates (count); Spark 3 / Flame 30 / Blaze+ null(∞). Global library templates are unlimited for all.
};

// Subscription statuses that DENY access (the coarse gate). past_due / pending are
// intentionally NOT here — they're a grace/dunning window (mirrors the client
// paywall, which only blocks expired/cancelled/paused).
export const BLOCKED_STATUSES = new Set(['expired', 'cancelled', 'paused', 'no_subscription']);
