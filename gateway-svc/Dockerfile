FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node

# 3000 = public completions API
# 3001 = internal admin API (never published externally — internal network / internal ingress port only)
EXPOSE 3000 3001

ENV NODE_ENV=production \
    PORT=3000 \
    ADMIN_PORT=3001 \
    ADMIN_BIND=0.0.0.0

# node:20-slim (Debian) has no wget/curl like alpine's busybox did — use Node itself instead
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
