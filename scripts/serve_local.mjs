// Local verification server — HTTP routes only, no Redis worker/sweeper.
// Throwaway (gitignored from commits). Run: node --env-file=.env scripts/serve_local.mjs
import '../src/config.js';
import app from '../src/server.js';
import { config } from '../src/config.js';
app.listen(config.port, () => console.log(`API (routes only) on ${config.port}`));
