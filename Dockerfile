# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: install production dependencies
# -----------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /app

# Copy lockfile + manifest first for better layer caching
COPY package.json package-lock.json* ./

# Install production deps only. npm ci if a lockfile exists, npm install otherwise.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# -----------------------------------------------------------------------------
# Stage 2: runtime image
# -----------------------------------------------------------------------------
FROM node:22-slim

# OCI metadata
LABEL org.opencontainers.image.title="Klebb" \
      org.opencontainers.image.description="Manifest-driven self-hosted personal health dashboard" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/Aristocles/klebb"

# Runtime system dependencies:
#   ca-certificates — HTTPS trust anchors for outbound calls (chat gateway, Fish Audio)
#   tini            — proper PID 1 so SIGTERM reaches Node cleanly
#   gosu            — privilege drop from root -> klebb in the entrypoint
#   ffmpeg          — transcode browser voice-note audio to 16 kHz mono WAV for Fish ASR
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
      gosu \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user
RUN groupadd --system --gid 1001 klebb \
 && useradd --system --uid 1001 --gid klebb --home-dir /app --shell /usr/sbin/nologin klebb

WORKDIR /app

# Production node_modules from the deps stage
COPY --from=deps --chown=klebb:klebb /app/node_modules ./node_modules

# Application source — only what the server actually needs at runtime
COPY --chown=klebb:klebb package.json ./
COPY --chown=klebb:klebb server.js ./
COPY --chown=klebb:klebb auth ./auth
COPY --chown=klebb:klebb chat ./chat
COPY --chown=klebb:klebb config ./config
COPY --chown=klebb:klebb manifests ./manifests
COPY --chown=klebb:klebb public ./public
COPY --chown=klebb:klebb scripts ./scripts
COPY --chown=klebb:klebb voice ./voice
COPY --chown=klebb:klebb health-auto-export ./health-auto-export
COPY --chown=klebb:klebb server ./server
COPY --chown=klebb:klebb templates ./templates
COPY --chown=klebb:klebb prompts ./prompts

# Data dir — mount a volume here in production. The entrypoint chowns
# this to the runtime user at container start so bind-mounts owned by
# the host user Just Work on first boot.
RUN mkdir -p /data && chown klebb:klebb /data

# Entrypoint script — runs as root, fixes /data ownership, drops to klebb.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Runtime config
ENV NODE_ENV=production \
    PORT=10002 \
    HOST=0.0.0.0 \
    HEALTH_HOME=/data \
    TZ=UTC

EXPOSE 10002

# Operator contract — bind-mount persistent data here
VOLUME ["/data"]

STOPSIGNAL SIGTERM

# Dependency-free liveness probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 10002) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

# NOTE: no `USER klebb` directive here — the entrypoint runs as root so
# it can chown /data, then drops to klebb via gosu before exec'ing node.

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
