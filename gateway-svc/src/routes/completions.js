// src/routes/completions.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getAdapter } = require('../adapters');
const { getDb } = require('../db/database');

router.post('/chat/completions', authMiddleware, async (req, res) => {
  const { subscription, backend } = req;
  const db = getDb();

  // Validate request body
  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Request body must include a non-empty "messages" array.',
        type: 'invalid_request_error'
      }
    });
  }

  const logEntry = {
    subscription_id: subscription.id,
    product_id: subscription.product_id,
    backend_id: backend.id,
    model: body.model || backend.config.model || 'unknown',
    status: 'error',
    error_msg: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    latency_ms: 0
  };

  try {
    const adapter = getAdapter(backend.type);
    const result = await adapter.complete(backend.config, body);

    const usage = result.normalized.usage || {};
    logEntry.status = 'success';
    logEntry.prompt_tokens = usage.prompt_tokens || 0;
    logEntry.completion_tokens = usage.completion_tokens || 0;
    logEntry.total_tokens = usage.total_tokens || 0;
    logEntry.latency_ms = result._latency;
    logEntry.model = result.normalized.model || logEntry.model;

    res.json(result.normalized);
  } catch (err) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.error?.message || err.message;
    logEntry.error_msg = msg;
    logEntry.status = 'error';

    res.status(status >= 400 && status < 600 ? status : 502).json({
      error: {
        message: `Backend error: ${msg}`,
        type: 'backend_error',
        backend: backend.name
      }
    });
  } finally {
    db.prepare(`
      INSERT INTO usage_log (subscription_id, product_id, backend_id, model, status, error_msg,
        prompt_tokens, completion_tokens, total_tokens, latency_ms)
      VALUES (@subscription_id, @product_id, @backend_id, @model, @status, @error_msg,
        @prompt_tokens, @completion_tokens, @total_tokens, @latency_ms)
    `).run(logEntry);
  }
});

module.exports = router;
