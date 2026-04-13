# Agent Swarm MCP Server Dockerfile
# Multi-stage build: compiles to standalone binary for minimal image size

# Stage 1: Build the binary
FROM oven/bun:latest AS builder

WORKDIR /build

# Copy package files first for better layer caching
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source files
COPY src/ ./src/
COPY tsconfig.json ./

# Compile HTTP server to standalone binary
RUN bun build ./src/http.ts --compile --outfile ./agent-swarm-api

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

# Install minimal dependencies (for bun:sqlite and networking)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    curl \
    jq \
    fuse3 libfuse2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /build/agent-swarm-api /usr/local/bin/agent-swarm-api
RUN chmod +x /usr/local/bin/agent-swarm-api

# Copy package.json for version info
COPY package.json ./

# Copy migration SQL files (compiled binary can't read from /$bunfs virtual filesystem)
COPY src/be/migrations/*.sql /app/migrations/

# Install archil CLI for FUSE/R2-backed disk mounts
RUN curl https://s3.amazonaws.com/archil-client/install | sh

# Create data directory for SQLite (WAL mode needs .sqlite, .sqlite-wal, .sqlite-shm on same filesystem)
# Create Archil mount point directories
RUN mkdir -p /app/data /mnt/data /workspace/shared

ENV PORT=3013
ENV DATABASE_PATH=/app/data/agent-swarm-db.sqlite
ENV MIGRATIONS_DIR=/app/migrations

VOLUME /app/data

EXPOSE 3013

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3013/health || exit 1

COPY api-entrypoint.sh /api-entrypoint.sh
RUN chmod +x /api-entrypoint.sh

ENTRYPOINT ["/api-entrypoint.sh"]
