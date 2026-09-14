# Multi-arch friendly (amd64 / arm64) — Node + better-sqlite3 native build
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reinstall production deps so native module matches runtime arch
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY public ./public

ENV MEDIA_PATH=/media \
    DATA_PATH=/data \
    PORT=8096 \
    NODE_ENV=production

EXPOSE 8096
VOLUME ["/media", "/data"]

CMD ["node", "dist/index.js"]
