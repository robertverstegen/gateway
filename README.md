# LLM API Gateway

A Node.js API gateway fronting multiple LLM backends (Claude, Azure OpenAI) behind a unified OpenAI-compatible API. Runs as two Docker containers with network-level separation between the public API and the admin UI.

---

## Container Architecture

```
Internet
   │
   │  port 3000 (public)
   ▼
┌──────────────────────────────┐
│  gateway container           │  ── public network ──► LLM APIs
│  POST /v1/chat/completions   │
│  GET  /health                │  ── internal network (no internet)
│                              │         │
│  port 3001 (admin API)  ─────┼─────────┤
│  /admin/*  (internal only)   │         │
└──────────────────────────────┘         │
                                         │
┌──────────────────────────────┐         │
│  admin-ui container          │ ◄───────┘
│  port 8080 (loopback only)   │  internal network only
│  Web UI + proxy → :3001      │  no internet access
└──────────────────────────────┘
   │
   │  127.0.0.1:8080 only
   ▼
 Your browser (via VPN / SSH tunnel / internal network)
```

### Network isolation

| Container | Networks | Internet access |
|-----------|----------|-----------------|
| `gateway` | `public` + `internal` | Yes (needs to call LLM APIs) |
| `admin-ui` | `internal` only | **No** — Docker `internal: true` blocks all outbound traffic |

The admin API (port 3001) is never published to the host. It is only reachable from `admin-ui` via the internal Docker network.

The admin UI (port 8080) is bound to `127.0.0.1` on the host — not reachable from the internet. Access it via SSH tunnel or an internal network/VPN.

---

## Quick Start

```bash
cp .env.example .env
# Edit .env — set ADMIN_KEY, UI_USERNAME, UI_PASSWORD, and your LLM API keys

docker compose up -d
```

- **Completions API:** `http://your-server:3000/v1/chat/completions`
- **Admin UI:** `http://localhost:8080` (loopback only — use SSH tunnel from remote)

SSH tunnel example:
```bash
ssh -L 8080:localhost:8080 user@your-server
# Then open http://localhost:8080 in your browser
```

---

## API Reference

### Completions (public, port 3000)

```
POST /v1/chat/completions
X-Api-Key: gw-<subscription-key>
Content-Type: application/json

{
  "messages": [{ "role": "user", "content": "Hello!" }],
  "temperature": 0.7
}
```

### Management API (internal, port 3001 — proxied via admin-ui)

All endpoints require `X-Admin-Key: <ADMIN_KEY>`.

#### Backends
| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/backends | List backends |
| POST | /admin/backends | Add backend |
| PATCH | /admin/backends/:id | Update (config, name, enabled) |
| DELETE | /admin/backends/:id | Remove |
| POST | /admin/backends/:id/disable | **Kill switch** |
| POST | /admin/backends/:id/enable | Re-enable |

#### Products
| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/products | List |
| POST | /admin/products | Create |
| PATCH | /admin/products/:id | Update |
| DELETE | /admin/products/:id | Delete |

#### Subscriptions
| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/subscriptions | List (key prefix only) |
| POST | /admin/subscriptions | Create — returns key **once** |
| PATCH | /admin/subscriptions/:id | Enable/disable, rate limit |
| DELETE | /admin/subscriptions/:id | Revoke |

#### Stats & Logs
| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/stats | Aggregates, hourly chart, recent errors |
| GET | /admin/usage | Raw log (filter: from, to, backend_id, status, limit) |

---

## Adding a New Backend Type

1. Create `src/adapters/yourtype.js` with `complete(config, body)` returning `{ _raw, _latency, normalized }` (normalized = OpenAI format)
2. Register in `src/adapters/index.js`

That's it — the new type appears in the UI and API automatically.

---

## Environment Variables

### Gateway
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Public completions port |
| `ADMIN_PORT` | `3001` | Internal admin API port |
| `ADMIN_BIND` | `0.0.0.0` | Admin bind address |
| `DB_PATH` | `/data/gateway.db` | SQLite path |
| `ADMIN_KEY` | `changeme` | Shared admin key |
| `CLAUDE_API_KEY` | — | Seeds Claude backend on first boot |
| `AZURE_OPENAI_ENDPOINT` | — | Seeds Azure backend on first boot |

### Admin UI
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | UI listen port |
| `GATEWAY_ADMIN_URL` | `http://gateway:3001` | Gateway internal admin URL |
| `ADMIN_KEY` | `changeme` | Forwarded to gateway API calls |
| `UI_USERNAME` | — | Enable HTTP basic auth on the UI |
| `UI_PASSWORD` | — | HTTP basic auth password |
