// src/routes/admin.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { hashKey } = require('../middleware/auth');
const { getAvailableTypes } = require('../adapters');

// Simple admin key auth
function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return next(); // No admin key configured = open (dev mode)

  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== adminKey) {
    return res.status(401).json({ error: 'Invalid admin key. Provide via X-Admin-Key header.' });
  }
  next();
}

router.use(adminAuth);

// ─── BACKENDS ────────────────────────────────────────────────────────────────

router.get('/backends', (req, res) => {
  const db = getDb();
  const backends = db.prepare('SELECT id, name, type, enabled, created_at FROM backends').all();
  res.json(backends);
});

router.get('/backends/:id', (req, res) => {
  const db = getDb();
  const backend = db.prepare('SELECT id, name, type, config, enabled, created_at FROM backends WHERE id = ?').get(req.params.id);
  if (!backend) return res.status(404).json({ error: 'Backend not found' });
  backend.config = JSON.parse(backend.config);
  res.json(backend);
});

router.post('/backends', (req, res) => {
  const { name, type, config } = req.body;
  if (!name || !type || !config) return res.status(400).json({ error: 'name, type, config required' });
  if (!getAvailableTypes().includes(type)) {
    return res.status(400).json({ error: `Unknown type. Available: ${getAvailableTypes().join(', ')}` });
  }

  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO backends (id, name, type, config) VALUES (?, ?, ?, ?)')
      .run(id, name, type, JSON.stringify(config));
    res.status(201).json({ id, name, type, enabled: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.patch('/backends/:id', (req, res) => {
  const db = getDb();
  const { enabled, config, name } = req.body;
  const updates = [];
  const vals = [];

  if (enabled !== undefined) { updates.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
  if (name !== undefined)    { updates.push('name = ?');    vals.push(name); }
  if (config !== undefined)  { updates.push('config = ?');  vals.push(JSON.stringify(config)); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(req.params.id);
  const result = db.prepare(`UPDATE backends SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  if (!result.changes) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true });
});

router.delete('/backends/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM backends WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true });
});

// Kill switch shortcuts
router.post('/backends/:id/disable', (req, res) => {
  const db = getDb();
  const result = db.prepare('UPDATE backends SET enabled = 0 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true, message: 'Backend kill switch activated' });
});

router.post('/backends/:id/enable', (req, res) => {
  const db = getDb();
  const result = db.prepare('UPDATE backends SET enabled = 1 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true, message: 'Backend enabled' });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

router.get('/products', (req, res) => {
  const db = getDb();
  const products = db.prepare(`
    SELECT p.*, b.name as backend_name, b.type as backend_type, b.enabled as backend_enabled
    FROM products p JOIN backends b ON p.backend_id = b.id
  `).all();
  res.json(products);
});

router.post('/products', (req, res) => {
  const { name, backend_id, description } = req.body;
  if (!name || !backend_id) return res.status(400).json({ error: 'name, backend_id required' });

  const db = getDb();
  const backend = db.prepare('SELECT id FROM backends WHERE id = ?').get(backend_id);
  if (!backend) return res.status(404).json({ error: 'Backend not found' });

  const id = uuidv4();
  try {
    db.prepare('INSERT INTO products (id, name, backend_id, description) VALUES (?, ?, ?, ?)')
      .run(id, name, backend_id, description || null);
    res.status(201).json({ id, name, backend_id, enabled: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.patch('/products/:id', (req, res) => {
  const db = getDb();
  const { enabled, name, description, backend_id } = req.body;
  const updates = [];
  const vals = [];

  if (enabled !== undefined)     { updates.push('enabled = ?');     vals.push(enabled ? 1 : 0); }
  if (name !== undefined)        { updates.push('name = ?');        vals.push(name); }
  if (description !== undefined) { updates.push('description = ?'); vals.push(description); }
  if (backend_id !== undefined)  { updates.push('backend_id = ?');  vals.push(backend_id); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);

  const result = db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  if (!result.changes) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
});

router.delete('/products/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
});

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

router.get('/subscriptions', (req, res) => {
  const db = getDb();
  const subs = db.prepare(`
    SELECT s.id, COALESCE(s.customer_ref, s.id) as customer_ref, s.name, s.key_prefix, s.product_id, s.enabled, s.rate_limit, s.created_at,
           p.name as product_name, b.name as backend_name
    FROM subscriptions s
    JOIN products p ON s.product_id = p.id
    JOIN backends b ON p.backend_id = b.id
    ORDER BY s.created_at DESC
  `).all();
  res.json(subs);
});

router.get('/subscriptions/:id', (req, res) => {
  const db = getDb();
  const sub = db.prepare(`
    SELECT s.id, COALESCE(s.customer_ref, s.id) as customer_ref, s.name, s.key_prefix, s.product_id, s.enabled, s.rate_limit, s.created_at,
           p.name as product_name, b.name as backend_name
    FROM subscriptions s
    JOIN products p ON s.product_id = p.id
    JOIN backends b ON p.backend_id = b.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  res.json(sub);
});

router.post('/subscriptions', (req, res) => {
  const { name, customer_ref, product_id, rate_limit } = req.body;
  if (!name || !customer_ref || !product_id) return res.status(400).json({ error: 'name, customer_ref, product_id required' });

  const db = getDb();
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Generate a secure random key
  const rawKey = `gw-${uuidv4().replace(/-/g, '')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 10);
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO subscriptions (id, customer_ref, name, key_hash, key_prefix, product_id, rate_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, customer_ref, name, keyHash, keyPrefix, product_id, rate_limit || 0);
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `Customer ref "${customer_ref}" already has a subscription for this product.` });
    throw e;
  }

  // Return the raw key ONCE - it cannot be retrieved again
  res.status(201).json({ id, customer_ref, name, key: rawKey, key_prefix: keyPrefix, product_id });
});

router.patch('/subscriptions/:id', (req, res) => {
  const db = getDb();
  const { enabled, name, customer_ref, rate_limit, product_id } = req.body;
  const updates = [];
  const vals = [];

  if (enabled !== undefined)       { updates.push('enabled = ?');      vals.push(enabled ? 1 : 0); }
  if (name !== undefined)          { updates.push('name = ?');         vals.push(name); }
  if (customer_ref !== undefined)  { updates.push('customer_ref = ?'); vals.push(customer_ref); }
  if (rate_limit !== undefined)    { updates.push('rate_limit = ?');   vals.push(rate_limit); }
  if (product_id !== undefined)    { updates.push('product_id = ?');   vals.push(product_id); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);

  const result = db.prepare(`UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  if (!result.changes) return res.status(404).json({ error: 'Subscription not found' });
  res.json({ ok: true });
});

router.delete('/subscriptions/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Subscription not found' });
  res.json({ ok: true });
});

// ─── USAGE / STATS ────────────────────────────────────────────────────────────

router.get('/usage', (req, res) => {
  const db = getDb();
  const { from, to, backend_id, subscription_id, limit = 200, status } = req.query;

  let query = `
    SELECT u.*, s.name as subscription_name, b.name as backend_name_resolved
    FROM usage_log u
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    LEFT JOIN backends b ON u.backend_id = b.id
    WHERE 1=1
  `;
  const params = [];

  if (from)            { query += ' AND u.ts >= ?'; params.push(from); }
  if (to)              { query += ' AND u.ts <= ?'; params.push(to); }
  if (backend_id)      { query += ' AND u.backend_id = ?'; params.push(backend_id); }
  if (subscription_id) { query += ' AND u.subscription_id = ?'; params.push(subscription_id); }
  if (status)          { query += ' AND u.status = ?'; params.push(status); }

  query += ' ORDER BY u.ts DESC LIMIT ?';
  params.push(parseInt(limit));

  res.json(db.prepare(query).all(...params));
});

router.get('/stats', (req, res) => {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(total_tokens) as total_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM usage_log
  `).get();

  const byBackend = db.prepare(`
    SELECT b.name, u.backend_id,
      COUNT(*) as requests,
      SUM(u.total_tokens) as tokens,
      SUM(CASE WHEN u.status = 'error' THEN 1 ELSE 0 END) as errors,
      AVG(u.latency_ms) as avg_latency_ms
    FROM usage_log u
    LEFT JOIN backends b ON u.backend_id = b.id
    GROUP BY u.backend_id
  `).all();

  const recentErrors = db.prepare(`
    SELECT u.ts, u.error_msg, u.backend_id, b.name as backend_name, s.name as subscription_name
    FROM usage_log u
    LEFT JOIN backends b ON u.backend_id = b.id
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    WHERE u.status = 'error'
    ORDER BY u.ts DESC LIMIT 20
  `).all();

  const { subscription_id: statsSubId } = req.query;
  const hourlyParams = [];
  let hourlyQuery = `
    SELECT strftime('%Y-%m-%dT%H:00:00', ts) as hour,
      COALESCE(s.name, 'unknown') as subscription_name,
      u.subscription_id,
      COUNT(*) as requests,
      SUM(u.total_tokens) as tokens
    FROM usage_log u
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    WHERE u.ts >= datetime('now', '-24 hours')
  `;
  if (statsSubId) { hourlyQuery += ' AND u.subscription_id = ?'; hourlyParams.push(statsSubId); }
  hourlyQuery += ' GROUP BY hour, u.subscription_id ORDER BY hour';
  const hourly = db.prepare(hourlyQuery).all(...hourlyParams);

  res.json({ totals, byBackend, recentErrors, hourly });
});

// ─── ADAPTER TYPES ────────────────────────────────────────────────────────────
router.get('/adapter-types', (req, res) => {
  res.json(getAvailableTypes());
});

module.exports = router;
