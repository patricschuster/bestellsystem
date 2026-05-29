# Dockerfile (v2.9.8) — Debian-Basis fuer vcgencmd-Kompatibilitaet auf dem Pi
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# System-Tools fuer Host-Monitoring:
#  - iw: WLAN-Stations-Info (Signal, Bitrate) – braucht network_mode:host auf dem Pi
#  - python3, build-essential: better-sqlite3 native build
RUN apt-get update \
 && apt-get install -y --no-install-recommends iw python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
