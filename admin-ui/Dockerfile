FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

USER node

EXPOSE 8086

ENV NODE_ENV=production \
    PORT=8086

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --tries=1 http://127.0.0.1:8086/health || exit 1

CMD ["node", "src/index.js"]
