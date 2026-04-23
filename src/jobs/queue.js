import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

export const jobQueue = new Queue('jobs', { connection });
