// src/index.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const completionsRouter = require('./routes/completions');
const adminRouter = require('./routes/admin');

// ─── Public gateway (completions only) ───────────────────────────────────────
const publicApp = express();
const PUBLIC_PORT = process.env.PORT || 3000;

publicApp.use(cors());
publicApp.use(express.json({ limit: '10mb' }));
publicApp.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

publicApp.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

publicApp.use('/v1', completionsRouter);

// Reject everything else on the public port
publicApp.use((req, res) => res.status(404).json({ error: 'Not found' }));

publicApp.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Internal admin API (separate port, bind to internal interface only) ─────
const adminApp = express();
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;
// Bind host — default 127.0.0.1 so only reachable from within the container
// or via Docker internal network when ADMIN_BIND=0.0.0.0
const ADMIN_BIND = process.env.ADMIN_BIND || '0.0.0.0';

adminApp.use(express.json({ limit: '1mb' }));
adminApp.use(morgan('dev'));

adminApp.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'admin' });
});

adminApp.use('/admin', adminRouter);

adminApp.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start both servers ───────────────────────────────────────────────────────
publicApp.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Gateway (public)  → http://0.0.0.0:${PUBLIC_PORT}`);
  console.log(`   POST /v1/chat/completions`);
  console.log(`   GET  /health`);
});

adminApp.listen(ADMIN_PORT, ADMIN_BIND, () => {
  console.log(`\n🔒 Admin API (internal) → http://${ADMIN_BIND}:${ADMIN_PORT}`);
  console.log(`   /admin/*  (requires X-Admin-Key)\n`);
});

module.exports = { publicApp, adminApp };
