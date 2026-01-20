/**
 * Fault Tolerant Control Server
 * 
 * Main entry point for the command orchestration server. 
 * 
 * Features:
 * - REST API for command management
 * - SQLite persistence with crash recovery
 * - Agent coordination and heartbeat monitoring
 * - Automatic stale command detection
 */

import express from 'express';
import path from 'path';
import { CommandDatabase } from './db/database';
// import { createCommandRoutes } from './routes/commands'; // Commented out for now
// import { createAgentRoutes } from './routes/agent';     // Commented out for now
import { DEFAULT_SERVER_PORT, DEFAULT_COMMAND_TIMEOUT } from '@fault-tolerant/shared';

// Configuration from environment
const PORT = parseInt(process.env.PORT || String(DEFAULT_SERVER_PORT), 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/commands.db');
const COMMAND_TIMEOUT = parseInt(process.env.COMMAND_TIMEOUT || String(DEFAULT_COMMAND_TIMEOUT), 10);
const STALE_CHECK_INTERVAL = parseInt(process.env.STALE_CHECK_INTERVAL || '10000', 10); // Check every 10s

console.log('='.repeat(60));
console.log('Skipr Control Server Starting...');
console.log('='.repeat(60));
console.log(`Port: ${PORT}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Command Timeout: ${COMMAND_TIMEOUT}ms`);
console.log(`Stale Check Interval: ${STALE_CHECK_INTERVAL}ms`);
console.log('='.repeat(60));

// Initialize database
const db = new CommandDatabase(DB_PATH);

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
// app.use('/commands', createCommandRoutes(db)); // Commented out for now
// app.use('/agent', createAgentRoutes(db));     // Commented out for now

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start stale command checker
const staleChecker = setInterval(() => {
  const resetCount = db.checkStaleCommands(COMMAND_TIMEOUT);
  if (resetCount > 0) {
    console.log(`[STALE] Reset ${resetCount} stale commands to PENDING`);
  }
}, STALE_CHECK_INTERVAL);

// Start server
const server = app.listen(PORT, () => {
  console.log(`[SERVER] Control Server listening on port ${PORT}`);
  console.log(`[SERVER] API endpoints:`);
  console.log(`         POST /commands     - Create a new command`);
  console.log(`         GET  /commands/:id - Get command status`);
  console.log(`         GET  /commands     - List all commands`);
  console.log(`         POST /agent/fetch  - Agent fetches next command`);
  console.log(`         POST /agent/result - Agent reports result`);
  console.log(`         POST /agent/sync   - Agent syncs on restart`);
  console.log(`         POST /agent/heartbeat - Agent heartbeat`);
  console.log(`         GET  /health       - Health check`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n[SERVER] Received ${signal}, shutting down gracefully...`);
  
  clearInterval(staleChecker);
  
  server.close(() => {
    console.log('[SERVER] HTTP server closed');
    db.close();
    console.log('[SERVER] Database closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[SERVER] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, db };
