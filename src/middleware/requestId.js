import { randomUUID } from 'node:crypto';

// Assigns a correlation id to every request and echoes it back so a client error
// report (or a customer's "it broke at 2:31pm") can be tied to the exact server
// log/Sentry event. Honours an inbound X-Request-Id so the same id can flow
// across services. Mount FIRST, before any route.
export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
