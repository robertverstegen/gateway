# Build stage — Debian-based so native modules compile against glibc
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Runtime stage — same glibc base, no build tools
FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000 3001
ENV NODE_ENV=production \
    PORT=3000 \
    ADMIN_PORT=3001 \
    ADMIN_BIND=0.0.0.0 \
    DB_PATH=/data/gateway.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "src/index.js"]