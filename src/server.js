import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use('/api', jobsRouter);

export default app;
