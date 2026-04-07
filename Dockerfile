# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-slim

# Cache-busting ARG — injected by CI with the git SHA so containerd
# always treats each build as a distinct image, preventing stale caches.
ARG GIT_SHA=unknown
LABEL git-sha=$GIT_SHA

# Install docker CLI (no daemon — connects to docker:dind sidecar via DOCKER_HOST)
RUN apt-get update && apt-get install -y ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY package*.json ./

# Agent skills and agent-runner source (synced into per-group dirs at runtime)
COPY container/ ./container/

# Runtime scripts (e.g. cleanup-sessions.sh used by session-cleanup.ts)
COPY scripts/ ./scripts/

# Runtime directories — overridden by PVC mounts in Kubernetes
RUN mkdir -p store groups data logs

# Credential proxy port
EXPOSE 3001

CMD ["node", "dist/index.js"]
