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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /build/agent-swarm-api /usr/local/bin/agent-swarm-api
RUN chmod +x /usr/local/bin/agent-swarm-api

# Copy package.json for version info
COPY package.json ./

# Create data directory for SQLite (WAL mode needs .sqlite, .sqlite-wal, .sqlite-shm on same filesystem)
RUN mkdir -p /app/data

ENV PORT=3013
ENV DATABASE_PATH=/app/data/agent-swarm-db.sqlite

EXPOSE 3013

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3013/health || exit 1

# Print version on startup and run the server
CMD echo "=== Agent Swarm API v$(cat /app/package.json | grep '\"version\"' | cut -d'"' -f4) ===" && \
    echo "Port: $PORT" && \
    echo "Database: $DATABASE_PATH" && \
    echo "==============================" && \
    exec /usr/local/bin/agent-swarm-api
