# Build stage — needs full toolchain for better-sqlite3 native bindings
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Runtime stage — slim image, far fewer CVEs, no build tools
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