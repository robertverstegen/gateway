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
  // Base tables — these match the original schema exactly so IF NOT EXISTS is safe
  db.exec(`
    CREATE TABLE IF NOT EXISTS backends (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      type       TEXT NOT NULL,
      config     TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      backend_id  TEXT NOT NULL REFERENCES backends(id),
      description TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      product_id   TEXT NOT NULL REFERENCES products(id),
      enabled      INTEGER NOT NULL DEFAULT 1,
      rate_limit   INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id   TEXT,
      product_id        TEXT,
      backend_id        TEXT,
      ts                TEXT NOT NULL DEFAULT (datetime('now')),
      model             TEXT,
      prompt_tokens     INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens      INTEGER DEFAULT 0,
      latency_ms        INTEGER DEFAULT 0,
      status            TEXT NOT NULL,
      error_msg         TEXT
    )
  `);

  // Base indexes — safe on original schema
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_log(ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_sub     ON usage_log(subscription_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_backend ON usage_log(backend_id)`);

  // ── Migrations ──────────────────────────────────────────────────────────────
  // Each runs independently so a failure in one doesn't block the others.

  const subCols = db.prepare('PRAGMA table_info(subscriptions)').all().map(c => c.name);
  if (!subCols.includes('customer_ref')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN customer_ref TEXT`);
    db.exec(`UPDATE subscriptions SET customer_ref = id WHERE customer_ref IS NULL`);
  }

  const logCols = db.prepare('PRAGMA table_info(usage_log)').all().map(c => c.name);
  if (!logCols.includes('customer_ref')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN customer_ref TEXT`);
  }

  // Indexes that depend on migrated columns — wrapped individually so they're skipped if already exist
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_log(customer_ref)`); } catch(_) {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_customer_product ON subscriptions(customer_ref, product_id)`); } catch(_) {}

  seedDefaults(db);
}

function seedDefaults(db) {
  const claudeExists = db.prepare("SELECT 1 FROM backends WHERE name = 'claude'").get();
  if (!claudeExists && process.env.CLAUDE_API_KEY) {
    db.prepare(`INSERT INTO backends (id, name, type, config) VALUES (?, 'claude', 'claude', ?)`)
      .run(uuidv4(), JSON.stringify({
        api_key: process.env.CLAUDE_API_KEY,
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096
      }));
  }

  const azureExists = db.prepare("SELECT 1 FROM backends WHERE name = 'azure_openai'").get();
  if (!azureExists && process.env.AZURE_OPENAI_ENDPOINT) {
    db.prepare(`INSERT INTO backends (id, name, type, config) VALUES (?, 'azure_openai', 'azure_openai', ?)`)
      .run(uuidv4(), JSON.stringify({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        api_key: process.env.AZURE_OPENAI_KEY,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
        api_version: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
      }));
  }
}

module.exports = { getDb };
