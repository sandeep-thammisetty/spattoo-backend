import { logError } from '../lib/telemetry.js';

// Global Express error handler — the safety net. Catches anything passed to
// next(err) (e.g. rbac.js) and synchronous throws in handlers. Mount LAST, after
// all routers. Reports to centralised telemetry, then returns a clean,
// non-leaky JSON shape that includes the request id for support correlation.
//
// NOTE: Express 4 does NOT auto-forward rejected async handlers here. Routes that
// `await` without try/catch won't reach this. Phase 0 keeps the existing per-route
// try/catch; this handler upgrades next(err) + sync throws + is the seam for a
// later async-wrapper. The process-level handlers in telemetry catch the rest.
export function errorHandler(err, req, res, next) {
  logError(err, req);

  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : (err.message || 'Error'),
    request_id: req.id,
  });
}
