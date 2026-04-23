import './config.js';
import app from './server.js';
import { startWorker } from './jobs/worker.js';
import { config } from './config.js';

startWorker();

app.listen(config.port, () => {
  console.log(`API running on port ${config.port}`);
});
