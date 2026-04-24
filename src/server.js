import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import elementsRouter from './routes/elements.js';
import templatesRouter from './routes/templates.js';
import storageRouter from './routes/storage.js';
import bakersRouter from './routes/bakers.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use('/api', jobsRouter);
app.use('/api', elementsRouter);
app.use('/api', templatesRouter);
app.use('/api', storageRouter);
app.use('/api', bakersRouter);

export default app;
