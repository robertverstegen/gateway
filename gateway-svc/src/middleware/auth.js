// src/middleware/auth.js
const crypto = require('crypto');
const { getDb } = require('../db/database');

const rateLimitWindows = new Map();

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function checkRateLimit(keyHash, limitPerMinute) {
  if (!limitPerMinute || limitPerMinute === 0) return true;

  const now = Date.now();
  const windowMs = 60 * 1000;
  const timestamps = rateLimitWindows.get(keyHash) || [];
  const recent = timestamps.filter(t => now - t < windowMs);

  if (recent.length >= limitPerMinute) return false;

  recent.push(now);
  rateLimitWindows.set(keyHash, recent);
  return true;
}

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  // x-subscription-id is the customer-supplied business reference (e.g. a customer ID).
  // When provided, the gateway verifies the key belongs to that customer ref.
  const subscriptionId = req.headers['x-subscription-id'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Provide via X-Api-Key header or Bearer token.' });
  }

  const keyHash = hashKey(apiKey);
  const db = getDb();

  const sub = db.prepare(`
    SELECT s.*, p.id as pid, p.name as product_name, p.backend_id, p.enabled as product_enabled,
           b.name as backend_name, b.type as backend_type, b.config as backend_config,
           b.enabled as backend_enabled
    FROM subscriptions s
    JOIN products p ON s.product_id = p.id
    JOIN backends b ON p.backend_id = b.id
    WHERE s.key_hash = ?
  `).get(keyHash);

  if (!sub) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  // Validate x-subscription-id against the customer_ref stored on the subscription.
  // Two subscriptions can share the same customer_ref (different products), so this
  // confirms the key's owner matches the caller's claimed identity.
  if (subscriptionId && subscriptionId !== sub.customer_ref) {
    return res.status(401).json({
      error: 'Subscription ID does not match the provided API key.',
      hint: 'X-Subscription-Id must match the customer reference of the subscription this key belongs to.'
    });
  }

  if (!sub.enabled) {
    return res.status(403).json({ error: 'Subscription is disabled.' });
  }

  if (!sub.product_enabled) {
    return res.status(403).json({ error: `Product "${sub.product_name}" is disabled.` });
  }

  if (!sub.backend_enabled) {
    return res.status(503).json({ error: `Backend "${sub.backend_name}" is currently disabled (kill switch active).` });
  }

  if (!checkRateLimit(keyHash, sub.rate_limit)) {
    return res.status(429).json({ error: 'Rate limit exceeded.' });
  }

  req.subscription = sub;
  req.backend = {
    id: sub.backend_id,
    name: sub.backend_name,
    type: sub.backend_type,
    config: JSON.parse(sub.backend_config),
    enabled: sub.backend_enabled
  };

  next();
}

module.exports = { authMiddleware, hashKey };
