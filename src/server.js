import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import elementsRouter from './routes/elements.js';
import templatesRouter from './routes/templates.js';
import tagsRouter from './routes/tags.js';
import storageRouter from './routes/storage.js';
import bakersRouter from './routes/bakers.js';
import ordersRouter from './routes/orders.js';
import customersRouter from './routes/customers.js';
import dashboardRouter from './routes/dashboard.js';
import billingRouter from './routes/billing.js';
import subscriptionsRouter from './routes/subscriptions.js';
import craftGuideRouter from './routes/craftGuide.js';
import nozzlesRouter from './routes/nozzles.js';

const app = express();

app.use(cors());

// Webhook needs raw body for Razorpay signature verification — mount before express.json()
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '5mb' }));

app.use(healthRouter);
app.use('/api', jobsRouter);
app.use('/api', elementsRouter);
app.use('/api', templatesRouter);
app.use('/api', tagsRouter);
app.use('/api', storageRouter);
app.use('/api', bakersRouter);
app.use('/api', ordersRouter);
app.use('/api', customersRouter);
app.use('/api', dashboardRouter);
app.use('/api', billingRouter);
app.use('/api', subscriptionsRouter);
app.use('/api', craftGuideRouter);
app.use('/api', nozzlesRouter);

export default app;
