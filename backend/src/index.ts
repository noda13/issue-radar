import 'dotenv/config';
import express from 'express';
import { config } from './lib/config.js';
import adminRouter from './routes/admin.js';
import issuesRouter from './routes/issues.js';
import ideasRouter from './routes/ideas.js';
import { startScheduler } from './jobs/scheduler.js';

const app = express();

// Middleware
app.use(express.json());

// CORS: allow all origins
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Handle OPTIONS preflight
app.options('*', (_req, res) => {
  res.sendStatus(204);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Routes
app.use('/api/admin', adminRouter);
app.use('/api/issues', issuesRouter);
app.use('/api/ideas', ideasRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[Express] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  },
);

// Start server
app.listen(config.port, () => {
  console.log(`[Server] issue-radar backend listening on port ${config.port}`);
  console.log(`[Server] Health check: http://localhost:${config.port}/health`);
});

// Start scheduler
startScheduler();

// Graceful uncaught error handling
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
  console.error(err.stack);
  // Do not exit — keep the server running for recoverable errors
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', String(reason));
});
