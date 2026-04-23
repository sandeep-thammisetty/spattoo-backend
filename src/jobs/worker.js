import { Worker } from 'bullmq';
import { connection } from './queue.js';
import { extractImage } from './processors/extractImage.js';

const processors = {
  extract_image: extractImage,
};

export function startWorker() {
  const worker = new Worker('jobs', async job => {
    const processor = processors[job.name];
    if (!processor) throw new Error(`Unknown job type: ${job.name}`);
    await processor(job.data);
  }, { connection });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} (${job?.name}) failed:`, err.message);
  });

  console.log('Worker started');
  return worker;
}
