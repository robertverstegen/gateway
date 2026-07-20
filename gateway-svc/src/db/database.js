// src/db/database.js
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool;

function getPool() {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Example: postgres://user:pass@host:5432/gateway');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Azure Database for PostgreSQL Flexible Server requires TLS. rejectUnauthorized:false
      // keeps this working against Azure's managed cert chain without bundling a CA file;
      // tighten this (load Azure's root CA) if you need strict verification.
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function initSchema() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS backends (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      type       TEXT NOT NULL,
      config     TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      backend_id  TEXT NOT NULL REFERENCES backends(id),
      description TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           TEXT PRIMARY KEY,
      customer_ref TEXT NOT NULL,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      product_id   TEXT NOT NULL REFERENCES products(id),
      enabled      INTEGER NOT NULL DEFAULT 1,
      rate_limit   INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(customer_ref, product_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subscription_id   TEXT,
      customer_ref      TEXT,
      product_id        TEXT,
      backend_id        TEXT,
      ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
      model             TEXT,
      prompt_tokens     INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens      INTEGER DEFAULT 0,
      latency_ms        INTEGER DEFAULT 0,
      status            TEXT NOT NULL,
      error_msg         TEXT
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_ts       ON usage_log(ts)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_sub      ON usage_log(subscription_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_log(customer_ref)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_backend  ON usage_log(backend_id)`);

  await seedDefaults(db);
}

async function seedDefaults(db) {
  const { v4: uuidv4 } = require('uuid');

  const claudeExists = (await db.query("SELECT 1 FROM backends WHERE name = 'claude'")).rowCount > 0;
  if (!claudeExists && process.env.CLAUDE_API_KEY) {
    await db.query(
      `INSERT INTO backends (id, name, type, config) VALUES ($1, 'claude', 'claude', $2)`,
      [uuidv4(), JSON.stringify({
        api_key: process.env.CLAUDE_API_KEY,
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096
      })]
    );
  }

  const azureExists = (await db.query("SELECT 1 FROM backends WHERE name = 'azure_openai'")).rowCount > 0;
  if (!azureExists && process.env.AZURE_OPENAI_ENDPOINT) {
    await db.query(
      `INSERT INTO backends (id, name, type, config) VALUES ($1, 'azure_openai', 'azure_openai', $2)`,
      [uuidv4(), JSON.stringify({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        api_key: process.env.AZURE_OPENAI_KEY,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
        api_version: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
      })]
    );
  }

  const mistralExists = (await db.query("SELECT 1 FROM backends WHERE name = 'mistral'")).rowCount > 0;
  if (!mistralExists && process.env.MISTRAL_API_KEY) {
    await db.query(
      `INSERT INTO backends (id, name, type, config) VALUES ($1, 'mistral', 'mistral', $2)`,
      [uuidv4(), JSON.stringify({
        api_key: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL || 'mistral-large-latest'
      })]
    );
  }
}

let initialized = null;

// Returns the pool, guaranteeing schema init has run exactly once first.
async function getDb() {
  const db = getPool();
  if (!initialized) {
    initialized = initSchema();
  }
  await initialized;
  return db;
}

module.exports = { getDb };
