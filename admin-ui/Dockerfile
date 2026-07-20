FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

USER node

EXPOSE 8086

ENV NODE_ENV=production \
    PORT=8086

# node:20-slim (Debian) has no wget/curl like alpine's busybox did — use Node itself instead
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8086/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
