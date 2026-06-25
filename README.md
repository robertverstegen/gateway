# LLM API Gateway

A Node.js API gateway that fronts multiple LLM backends (Claude, Azure OpenAI) behind a unified OpenAI-compatible API. Runs as two isolated Docker containers. Features subscription key auth, customer references, per-backend kill switches, structured output support, usage monitoring, and a web admin UI.

---

## Container Architecture

```
Internet
   │
   │  port 3000 (public)
   ▼
┌──────────────────────────────┐
│  gateway-svc                 │  ── public network ──► LLM APIs (Claude, Azure OpenAI)
│  POST /v1/chat/completions   │
│  GET  /health                │
│                              │
│  port 3001 (admin API) ──────┼──── internal network (Docker internal: true, no internet)
└──────────────────────────────┘         │
                                         │
┌──────────────────────────────┐         │
│  admin-ui                    │ ◄───────┘
│  port 8086                   │  proxies /admin/* → gateway:3001
│  Web dashboard               │  no direct internet access
└──────────────────────────────┘
   │
   └── accessible via nginx / SSH tunnel
```

### Network isolation

| Container | Networks | Internet |
|-----------|----------|---------|
| `gateway` | `public` + `internal` | Yes — needs to reach LLM APIs |
| `admin-ui` | `admin-facing` + `internal` | No — `internal: true` blocks outbound traffic |

The admin API (port 3001) is never published to the host. The admin UI proxies all `/admin/*` calls to `gateway:3001` over the internal network, injecting the `X-Admin-Key` header server-side — the key never touches the browser.

---

## Quick Start

```bash
cp .env.example .env          # fill in ADMIN_KEY, API keys, UI_USERNAME/PASSWORD
mkdir -p data
sudo chown -R 1000:1000 data  # node user inside container needs write access
docker compose up -d --build
```

- **Completions API:** `http://your-server:3000/v1/chat/completions`
- **Admin UI:** `http://your-server:8086` (proxy via nginx or SSH tunnel)

---

## Project Structure

```
gateway/
├── docker-compose.yml
├── .env.example
├── README.md
├── data/                     # SQLite database (bind-mounted, persists on host)
│   └── gateway.db
├── gateway-svc/              # API gateway container
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js          # Dual Express servers (public :3000, admin :3001)
│       ├── adapters/
│       │   ├── claude.js     # Anthropic API adapter
│       │   ├── azure_openai.js
│       │   └── index.js      # Adapter registry
│       ├── db/
│       │   └── database.js   # SQLite schema + seeding
│       ├── middleware/
│       │   └── auth.js       # Subscription key + customer ref validation
│       └── routes/
│           ├── completions.js # POST /v1/chat/completions
│           └── admin.js      # Management REST API
└── admin-ui/                 # Admin dashboard container
    ├── Dockerfile
    ├── package.json
    └── src/
        └── index.js          # Express + proxy to gateway:3001
    └── public/
        └── index.html        # Single-page admin dashboard
```

---

## Completions API

### Authentication

Every request requires an API key. Provide it as:
- `X-Api-Key: gw-<key>` header
- `Authorization: Bearer gw-<key>` header

Optionally, supply `X-Subscription-Id: <customer_ref>` to verify the key belongs to the expected customer. The gateway cross-checks the key's stored customer reference and returns 401 if they don't match.

### Request

```
POST /v1/chat/completions
X-Api-Key: gw-<your-key>
X-Subscription-Id: CUST-001        (optional — verifies key ownership)
Content-Type: application/json
```

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024
}
```

### Structured Outputs

Both backends support structured outputs. Use the standard OpenAI `response_format` field:

**JSON object mode** — guarantees valid JSON output:
```json
{
  "messages": [{ "role": "user", "content": "Return a JSON object with a greeting." }],
  "response_format": { "type": "json_object" }
}
```

**JSON schema mode** — guarantees output matching your schema:
```json
{
  "messages": [{ "role": "user", "content": "Extract the name and age from: John is 30." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "person",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age":  { "type": "integer" }
        },
        "required": ["name", "age"],
        "additionalProperties": false
      }
    }
  }
}
```

| Backend | `text` | `json_object` | `json_schema` |
|---------|--------|--------------|--------------|
| Claude (Sonnet 4.5+, Opus 4.6+) | ✅ | ✅ | ✅ |
| Azure OpenAI (GPT-4o, GPT-4-turbo) | ✅ | ✅ | ✅ |

For Claude, the gateway translates `response_format` to Claude's `output_config` format and adds the required `anthropic-beta: structured-outputs-2025-11-13` header automatically.

### Response

All backends return the same OpenAI-compatible format regardless of which backend handled the request:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "claude-sonnet-4-6",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!", "refusal": null },
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 5,
    "total_tokens": 17,
    "prompt_tokens_details": { "cached_tokens": 0, "audio_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 0, "audio_tokens": 0, "accepted_prediction_tokens": 0, "rejected_prediction_tokens": 0 }
  },
  "system_fingerprint": null
}
```

---

## Routing Model

```
API Key  →  Subscription  →  Product  →  Backend
```

- A **subscription** holds an API key and belongs to one **product**
- A **product** points to one **backend**
- **customer_ref** is your business key (e.g. a customer ID) — set per subscription, multiple subscriptions can share the same ref across different products
- Disabling a **backend** instantly blocks all traffic to it (kill switch)
- Disabling a **product** blocks all subscriptions using it
- Disabling a **subscription** blocks that specific key

---

## Management API

All endpoints on port 3001 (internal only — access via admin UI or SSH tunnel to host).
Requires `X-Admin-Key: <ADMIN_KEY>` header.

### Backends

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/backends | List all backends |
| GET | /admin/backends/:id | Get backend with config |
| POST | /admin/backends | Create backend |
| PATCH | /admin/backends/:id | Update name, config, or enabled |
| DELETE | /admin/backends/:id | Delete |
| POST | /admin/backends/:id/disable | Kill switch — blocks all traffic instantly |
| POST | /admin/backends/:id/enable | Re-enable |

Backend config shapes:
```json
// Claude
{ "api_key": "sk-ant-...", "model": "claude-sonnet-4-6", "max_tokens": 4096 }

// Azure OpenAI
{ "endpoint": "https://YOUR.openai.azure.com", "api_key": "...", "deployment": "gpt-4", "api_version": "2024-02-15-preview" }
```

### Products

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/products | List |
| POST | /admin/products | Create (`name`, `backend_id`, `description`) |
| PATCH | /admin/products/:id | Update |
| DELETE | /admin/products/:id | Delete |

### Subscriptions

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/subscriptions | List (key prefix only — full key shown once at creation) |
| GET | /admin/subscriptions/:id | Get single subscription |
| POST | /admin/subscriptions | Create — returns the raw key **once** |
| PATCH | /admin/subscriptions/:id | Update name, customer_ref, product, rate limit, enabled |
| DELETE | /admin/subscriptions/:id | Revoke key |

Create body: `{ "name": "...", "customer_ref": "CUST-001", "product_id": "...", "rate_limit": 60 }`

### Stats & Logs

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/stats | Totals, per-backend breakdown, hourly chart, recent errors |
| GET | /admin/usage | Raw log — query params: `from`, `to`, `backend_id`, `subscription_id`, `status`, `limit` |

---

## Adding a New Backend Type

1. Create `gateway-svc/src/adapters/yourtype.js` and export `complete(config, body)` returning `{ _raw, _latency, normalized }` where `normalized` matches the OpenAI `chat.completion` format.
2. Register it in `gateway-svc/src/adapters/index.js`.

The new type appears in the admin UI and API automatically.

---

## Environment Variables

### Gateway (`gateway-svc`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Public completions port |
| `ADMIN_PORT` | `3001` | Internal admin API port |
| `ADMIN_BIND` | `0.0.0.0` | Admin bind address |
| `DB_PATH` | `/data/gateway.db` | SQLite database path |
| `ADMIN_KEY` | `changeme` | Shared admin key |
| `CLAUDE_API_KEY` | — | Auto-seeds Claude backend on first boot |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Default Claude model |
| `AZURE_OPENAI_ENDPOINT` | — | Auto-seeds Azure backend on first boot |
| `AZURE_OPENAI_KEY` | — | Azure API key |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4` | Azure deployment name |
| `AZURE_OPENAI_API_VERSION` | `2024-02-15-preview` | Azure API version |

### Admin UI (`admin-ui`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8086` | UI listen port |
| `GATEWAY_ADMIN_URL` | `http://gateway:3001` | Internal gateway admin URL |
| `ADMIN_KEY` | `changeme` | Injected as `X-Admin-Key` on all proxied requests |
| `UI_USERNAME` | — | Enables HTTP Basic Auth on the UI |
| `UI_PASSWORD` | — | HTTP Basic Auth password |
