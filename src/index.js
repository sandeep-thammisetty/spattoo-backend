import './config.js';
import app from './server.js';
import { startWorker } from './jobs/worker.js';
import { startSweeper } from './jobs/sweeper.js';
import { config } from './config.js';

startWorker();
startSweeper();

app.listen(config.port, () => {
  console.log(`API running on port ${config.port}`);
});
