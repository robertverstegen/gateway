FROM node:20-alpine

# Install build tools for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Data directory for SQLite persistence
RUN mkdir -p /data && chown node:node /data

USER node

# 3000 = public completions API
# 3001 = internal admin API (never published to host, internal Docker network only)
EXPOSE 3000 3001

ENV NODE_ENV=production \
    PORT=3000 \
    ADMIN_PORT=3001 \
    ADMIN_BIND=0.0.0.0 \
    DB_PATH=/data/gateway.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
