// src/db/database.js
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/gateway.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backends (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      type      TEXT NOT NULL,          -- 'claude' | 'azure_openai' | custom
      config    TEXT NOT NULL,          -- JSON: endpoint, api_key, model, etc.
      enabled   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      backend_id  TEXT NOT NULL REFERENCES backends(id),
      description TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,  -- SHA-256 of the actual key
      key_prefix   TEXT NOT NULL,         -- first 8 chars for display
      product_id   TEXT NOT NULL REFERENCES products(id),
      enabled      INTEGER NOT NULL DEFAULT 1,
      rate_limit   INTEGER DEFAULT 0,     -- requests/minute, 0=unlimited
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT,
      product_id    TEXT,
      backend_id    TEXT,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      model         TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens  INTEGER DEFAULT 0,
      latency_ms    INTEGER DEFAULT 0,
      status        TEXT NOT NULL,        -- 'success' | 'error'
      error_msg     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_sub ON usage_log(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_usage_backend ON usage_log(backend_id);
  `);

  // Seed default backends from env if not present
  seedDefaults(db);
}

function seedDefaults(db) {
  const claudeExists = db.prepare("SELECT 1 FROM backends WHERE type = 'claude'").get();
  if (!claudeExists && process.env.CLAUDE_API_KEY) {
    db.prepare(`INSERT INTO backends (id, name, type, config) VALUES (?, 'claude', 'claude', ?)`)
      .run(uuidv4(), JSON.stringify({
        api_key: process.env.CLAUDE_API_KEY,
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096
      }));
  }

  const azureExists = db.prepare("SELECT 1 FROM backends WHERE type = 'azure_openai'").get();
  if (!azureExists && process.env.AZURE_OPENAI_ENDPOINT) {
    db.prepare(`INSERT INTO backends (id, name, type, config) VALUES (?, 'Azure OpenAI', 'azure_openai', ?)`)
      .run(uuidv4(), JSON.stringify({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        api_key: process.env.AZURE_OPENAI_KEY,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
        api_version: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
      }));
  }
}

module.exports = { getDb };
