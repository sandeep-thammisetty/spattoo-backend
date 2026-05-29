import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import elementsRouter from './routes/elements.js';
import templatesRouter from './routes/templates.js';
import storageRouter from './routes/storage.js';
import bakersRouter from './routes/bakers.js';
import ordersRouter from './routes/orders.js';
import customersRouter from './routes/customers.js';
import dashboardRouter from './routes/dashboard.js';
import billingRouter from './routes/billing.js';

const app = express();

app.use(cors());

// Webhook needs raw body for Razorpay signature verification — mount before express.json()
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

app.use(healthRouter);
app.use('/api', jobsRouter);
app.use('/api', elementsRouter);
app.use('/api', templatesRouter);
app.use('/api', storageRouter);
app.use('/api', bakersRouter);
app.use('/api', ordersRouter);
app.use('/api', customersRouter);
app.use('/api', dashboardRouter);
app.use('/api', billingRouter);

export default app;
