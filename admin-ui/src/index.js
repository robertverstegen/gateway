// src/index.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8086;

const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'http://gateway:3001';
const ADMIN_KEY = process.env.ADMIN_KEY;

const UI_USERNAME = process.env.UI_USERNAME;
const UI_PASSWORD = process.env.UI_PASSWORD;

app.use(morgan('dev'));

// Optional HTTP basic auth
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

// Health check for this container (handled before proxy)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'admin-ui' });
});

// Proxy /admin/* to gateway, injecting the admin key header on every request
const adminProxy = createProxyMiddleware({
  target: GATEWAY_ADMIN_URL + '/admin',
  changeOrigin: true,
  pathRewrite: { '^/admin': '' },
  on: {
    proxyReq: (proxyReq) => {
      if (ADMIN_KEY) {
        proxyReq.setHeader('x-admin-key', ADMIN_KEY);
      }
    }
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Cannot reach gateway admin API', detail: err.message });
  }
});

app.use('/admin', adminProxy);

// Serve the web UI for everything else
app.use('/', express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🖥️  Admin UI running on http://0.0.0.0:${PORT}`);
  console.log(`   Proxying /admin/* → ${GATEWAY_ADMIN_URL}/admin/*`);
  console.log(`   Admin key: ${ADMIN_KEY ? 'configured' : 'NOT SET - admin calls will fail'}\n`);
  if (UI_USERNAME) console.log('   Basic auth: enabled');
});
