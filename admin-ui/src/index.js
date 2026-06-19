// src/index.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

// Gateway admin API base URL — reachable only on the internal Docker network
const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'http://gateway:3001';

// Optional: protect the admin UI itself with basic auth
const UI_USERNAME = process.env.UI_USERNAME;
const UI_PASSWORD = process.env.UI_PASSWORD;

app.use(morgan('dev'));

// Simple HTTP basic auth guard (optional — set UI_USERNAME + UI_PASSWORD to enable)
if (UI_USERNAME && UI_PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="LLM Gateway Admin"');
      return res.status(401).send('Authentication required');
    }
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user !== UI_USERNAME || pass !== UI_PASSWORD) {
      res.set('WWW-Authenticate', 'Basic realm="LLM Gateway Admin"');
      return res.status(401).send('Invalid credentials');
    }
    next();
  });
}

// Proxy all /admin/* and /health calls through to the gateway's internal admin port
app.use('/admin', createProxyMiddleware({
  target: GATEWAY_ADMIN_URL,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({ error: 'Cannot reach gateway admin API', detail: err.message });
    }
  }
}));

app.use('/gateway-health', createProxyMiddleware({
  target: GATEWAY_ADMIN_URL,
  changeOrigin: true,
  pathRewrite: { '^/gateway-health': '/health' }
}));

// Health check for this container
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'admin-ui' });
});

// Serve the web UI
app.use('/', express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🖥️  Admin UI running on http://0.0.0.0:${PORT}`);
  console.log(`   Proxying admin API → ${GATEWAY_ADMIN_URL}\n`);
  if (UI_USERNAME) console.log('   Basic auth: enabled');
});
