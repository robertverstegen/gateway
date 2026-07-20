// src/routes/admin.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { hashKey } = require('../middleware/auth');
const { getAvailableTypes } = require('../adapters');

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

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

// Wrap async handlers so rejected promises reach Express's error handler
// instead of crashing the process.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Builds "col1 = $2, col2 = $3" style SET clauses for dynamic PATCH endpoints.
// Placeholders start at $2 because $1 is reserved for the WHERE id below.
function buildSet(fields) {
  const clauses = [];
  const vals = [];
  let i = 2;
  for (const [col, val] of fields) {
    if (val !== undefined) {
      clauses.push(`${col} = $${i}`);
      vals.push(val);
      i++;
    }
  }
  return { clauses, vals };
}

// ─── BACKENDS ────────────────────────────────────────────────────────────────

router.get('/backends', ah(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT id, name, type, enabled, created_at FROM backends');
  res.json(rows);
}));

router.get('/backends/:id', ah(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query('SELECT id, name, type, config, enabled, created_at FROM backends WHERE id = $1', [req.params.id]);
  const backend = rows[0];
  if (!backend) return res.status(404).json({ error: 'Backend not found' });
  backend.config = JSON.parse(backend.config);
  res.json(backend);
}));

router.post('/backends', ah(async (req, res) => {
  const { name, type, config } = req.body;
  if (!name || !type || !config) return res.status(400).json({ error: 'name, type, config required' });
  if (!getAvailableTypes().includes(type)) {
    return res.status(400).json({ error: `Unknown type. Available: ${getAvailableTypes().join(', ')}` });
  }

  const db = await getDb();
  const id = uuidv4();
  try {
    await db.query('INSERT INTO backends (id, name, type, config) VALUES ($1, $2, $3, $4)',
      [id, name, type, JSON.stringify(config)]);
    res.status(201).json({ id, name, type, enabled: true });
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return res.status(409).json({ error: `Backend "${name}" already exists.` });
    throw e;
  }
}));

router.patch('/backends/:id', ah(async (req, res) => {
  const db = await getDb();
  const { enabled, config, name } = req.body;

  const { clauses, vals } = buildSet([
    ['enabled', enabled !== undefined ? (enabled ? 1 : 0) : undefined],
    ['name', name],
    ['config', config !== undefined ? JSON.stringify(config) : undefined]
  ]);

  if (!clauses.length) return res.status(400).json({ error: 'Nothing to update' });

  const result = await db.query(`UPDATE backends SET ${clauses.join(', ')} WHERE id = $1`, [req.params.id, ...vals]);
  if (!result.rowCount) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true });
}));

router.delete('/backends/:id', ah(async (req, res) => {
  const db = await getDb();
  const result = await db.query('DELETE FROM backends WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true });
}));

// Kill switch shortcuts
router.post('/backends/:id/disable', ah(async (req, res) => {
  const db = await getDb();
  const result = await db.query('UPDATE backends SET enabled = 0 WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true, message: 'Backend kill switch activated' });
}));

router.post('/backends/:id/enable', ah(async (req, res) => {
  const db = await getDb();
  const result = await db.query('UPDATE backends SET enabled = 1 WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Backend not found' });
  res.json({ ok: true, message: 'Backend enabled' });
}));

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

router.get('/products', ah(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(`
    SELECT p.*, b.name as backend_name, b.type as backend_type, b.enabled as backend_enabled
    FROM products p JOIN backends b ON p.backend_id = b.id
  `);
  res.json(rows);
}));

router.post('/products', ah(async (req, res) => {
  const { name, backend_id, description } = req.body;
  if (!name || !backend_id) return res.status(400).json({ error: 'name, backend_id required' });

  const db = await getDb();
  const backend = (await db.query('SELECT id FROM backends WHERE id = $1', [backend_id])).rows[0];
  if (!backend) return res.status(404).json({ error: 'Backend not found' });

  const id = uuidv4();
  try {
    await db.query('INSERT INTO products (id, name, backend_id, description) VALUES ($1, $2, $3, $4)',
      [id, name, backend_id, description || null]);
    res.status(201).json({ id, name, backend_id, enabled: true });
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return res.status(409).json({ error: `Product "${name}" already exists.` });
    throw e;
  }
}));

router.patch('/products/:id', ah(async (req, res) => {
  const db = await getDb();
  const { enabled, name, description, backend_id } = req.body;

  const { clauses, vals } = buildSet([
    ['enabled', enabled !== undefined ? (enabled ? 1 : 0) : undefined],
    ['name', name],
    ['description', description],
    ['backend_id', backend_id]
  ]);

  if (!clauses.length) return res.status(400).json({ error: 'Nothing to update' });

  const result = await db.query(`UPDATE products SET ${clauses.join(', ')} WHERE id = $1`, [req.params.id, ...vals]);
  if (!result.rowCount) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
}));

router.delete('/products/:id', ah(async (req, res) => {
  const db = await getDb();
  const result = await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
}));

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

router.get('/subscriptions', ah(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(`
    SELECT s.id, COALESCE(s.customer_ref, s.id) as customer_ref, s.name, s.key_prefix, s.product_id, s.enabled, s.rate_limit, s.created_at,
           p.name as product_name, b.name as backend_name
    FROM subscriptions s
    JOIN products p ON s.product_id = p.id
    JOIN backends b ON p.backend_id = b.id
    ORDER BY s.created_at DESC
  `);
  res.json(rows);
}));

router.get('/subscriptions/:id', ah(async (req, res) => {
  const db = await getDb();
  const { rows } = await db.query(`
    SELECT s.id, COALESCE(s.customer_ref, s.id) as customer_ref, s.name, s.key_prefix, s.product_id, s.enabled, s.rate_limit, s.created_at,
           p.name as product_name, b.name as backend_name
    FROM subscriptions s
    JOIN products p ON s.product_id = p.id
    JOIN backends b ON p.backend_id = b.id
    WHERE s.id = $1
  `, [req.params.id]);
  const sub = rows[0];
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  res.json(sub);
}));

router.post('/subscriptions', ah(async (req, res) => {
  const { name, customer_ref, product_id, rate_limit } = req.body;
  if (!name || !customer_ref || !product_id) return res.status(400).json({ error: 'name, customer_ref, product_id required' });

  const db = await getDb();
  const product = (await db.query('SELECT id FROM products WHERE id = $1', [product_id])).rows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Generate a secure random key
  const rawKey = `gw-${uuidv4().replace(/-/g, '')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 10);
  const id = uuidv4();

  try {
    await db.query(`
      INSERT INTO subscriptions (id, customer_ref, name, key_hash, key_prefix, product_id, rate_limit)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, customer_ref, name, keyHash, keyPrefix, product_id, rate_limit || 0]);
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return res.status(409).json({ error: `Customer ref "${customer_ref}" already has a subscription for this product.` });
    throw e;
  }

  // Return the raw key ONCE - it cannot be retrieved again
  res.status(201).json({ id, customer_ref, name, key: rawKey, key_prefix: keyPrefix, product_id });
}));

router.patch('/subscriptions/:id', ah(async (req, res) => {
  const db = await getDb();
  const { enabled, name, customer_ref, rate_limit, product_id } = req.body;

  const { clauses, vals } = buildSet([
    ['enabled', enabled !== undefined ? (enabled ? 1 : 0) : undefined],
    ['name', name],
    ['customer_ref', customer_ref],
    ['rate_limit', rate_limit],
    ['product_id', product_id]
  ]);

  if (!clauses.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const result = await db.query(`UPDATE subscriptions SET ${clauses.join(', ')} WHERE id = $1`, [req.params.id, ...vals]);
    if (!result.rowCount) return res.status(404).json({ error: 'Subscription not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'That customer_ref already has a subscription for this product.' });
    throw e;
  }
}));

router.delete('/subscriptions/:id', ah(async (req, res) => {
  const db = await getDb();
  const result = await db.query('DELETE FROM subscriptions WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Subscription not found' });
  res.json({ ok: true });
}));

// ─── USAGE / STATS ────────────────────────────────────────────────────────────

router.get('/usage', ah(async (req, res) => {
  const db = await getDb();
  const { from, to, backend_id, subscription_id, limit = 200, status } = req.query;

  let query = `
    SELECT u.*, s.name as subscription_name, b.name as backend_name_resolved
    FROM usage_log u
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    LEFT JOIN backends b ON u.backend_id = b.id
    WHERE 1=1
  `;
  const params = [];
  let i = 1;

  if (from)            { params.push(from); query += ` AND u.ts >= $${i++}`; }
  if (to)              { params.push(to); query += ` AND u.ts <= $${i++}`; }
  if (backend_id)      { params.push(backend_id); query += ` AND u.backend_id = $${i++}`; }
  if (subscription_id) { params.push(subscription_id); query += ` AND u.subscription_id = $${i++}`; }
  if (status)          { params.push(status); query += ` AND u.status = $${i++}`; }

  params.push(parseInt(limit));
  query += ` ORDER BY u.ts DESC LIMIT $${i++}`;

  const { rows } = await db.query(query, params);
  res.json(rows);
}));

router.get('/stats', ah(async (req, res) => {
  const db = await getDb();

  const totals = (await db.query(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(total_tokens) as total_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM usage_log
  `)).rows[0];

  const byBackend = (await db.query(`
    SELECT b.name, u.backend_id,
      COUNT(*) as requests,
      SUM(u.total_tokens) as tokens,
      SUM(CASE WHEN u.status = 'error' THEN 1 ELSE 0 END) as errors,
      AVG(u.latency_ms) as avg_latency_ms
    FROM usage_log u
    LEFT JOIN backends b ON u.backend_id = b.id
    GROUP BY u.backend_id, b.name
  `)).rows;

  const recentErrors = (await db.query(`
    SELECT u.ts, u.error_msg, u.backend_id, b.name as backend_name, s.name as subscription_name
    FROM usage_log u
    LEFT JOIN backends b ON u.backend_id = b.id
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    WHERE u.status = 'error'
    ORDER BY u.ts DESC LIMIT 20
  `)).rows;

  const { subscription_id: statsSubId } = req.query;
  const hourlyParams = [];
  let hourlyQuery = `
    SELECT to_char(date_trunc('hour', u.ts), 'YYYY-MM-DD"T"HH24:00:00') as hour,
      COALESCE(s.name, 'unknown') as subscription_name,
      u.subscription_id,
      COUNT(*) as requests,
      SUM(u.total_tokens) as tokens
    FROM usage_log u
    LEFT JOIN subscriptions s ON u.subscription_id = s.id
    WHERE u.ts >= now() - interval '24 hours'
  `;
  if (statsSubId) { hourlyParams.push(statsSubId); hourlyQuery += ` AND u.subscription_id = $1`; }
  hourlyQuery += ' GROUP BY hour, u.subscription_id, s.name ORDER BY hour';
  const hourly = (await db.query(hourlyQuery, hourlyParams)).rows;

  res.json({ totals, byBackend, recentErrors, hourly });
}));

// ─── ADAPTER TYPES ────────────────────────────────────────────────────────────
router.get('/adapter-types', (req, res) => {
  res.json(getAvailableTypes());
});

// ─── BACKUP ───────────────────────────────────────────────────────────────────
// Postgres has no single-file equivalent to better-sqlite3's db.backup(), so this
// exports all tables as a JSON snapshot instead of a binary .db file. For a full
// point-in-time binary backup, use pg_dump directly against the database, or rely
// on Azure Database for PostgreSQL's built-in automated backups.
router.get('/backup', ah(async (req, res) => {
  const db = await getDb();

  const [backends, products, subscriptions, usage_log] = await Promise.all([
    db.query('SELECT * FROM backends'),
    db.query('SELECT * FROM products'),
    db.query('SELECT * FROM subscriptions'),
    db.query('SELECT * FROM usage_log')
  ]);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dump = {
    exported_at: new Date().toISOString(),
    backends: backends.rows,
    products: products.rows,
    subscriptions: subscriptions.rows,
    usage_log: usage_log.rows
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="gateway-backup-${timestamp}.json"`);
  res.send(JSON.stringify(dump, null, 2));
}));

module.exports = router;
