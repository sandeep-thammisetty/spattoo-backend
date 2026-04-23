import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import elementsRouter from './routes/elements.js';
import templatesRouter from './routes/templates.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use('/api', jobsRouter);
app.use('/api', elementsRouter);
app.use('/api', templatesRouter);

export default app;
