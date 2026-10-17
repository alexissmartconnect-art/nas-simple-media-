# Multi-arch friendly (amd64 / arm64) — Node + better-sqlite3 native build + ffmpeg
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

# ffmpeg provides both ffmpeg (transcode + thumbs + subtitles) and ffprobe
# (codec / DTS / 5.1 detection). intel-media-va-driver enables optional
# VAAPI hardware transcoding when /dev/dri is passed through.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

# Run as the unprivileged "node" user (uid/gid 1000), never as root.
# /data must be writable by uid 1000 on the host bind mount, e.g. on Synology:
#   sudo chown -R 1000:1000 /volume1/docker/nas-simple-media/data
RUN mkdir -p /data /media \
    && chown -R node:node /data

ENV MEDIA_PATH=/media \
    DATA_PATH=/data \
    PORT=8096 \
    NODE_ENV=production \
    TRANSCODE_ENABLED=true \
    FFMPEG_PATH=ffmpeg \
    TRANSCODE_MAX_JOBS=1

EXPOSE 8096
VOLUME ["/media", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8096)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "dist/index.js"]
