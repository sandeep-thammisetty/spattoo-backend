import './config.js';
import app from './server.js';
import { startWorker } from './jobs/worker.js';
import { startSweeper } from './jobs/sweeper.js';
import { config } from './config.js';
import { initTelemetry } from './lib/telemetry.js';

await initTelemetry();

startWorker();
startSweeper();

app.listen(config.port, () => {
  console.log(`API running on port ${config.port}`);
});
