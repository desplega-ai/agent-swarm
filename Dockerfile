# Agent Swarm MCP Server Dockerfile
# Multi-stage build: compiles to standalone binary for minimal image size

# Stage 1: Build the binary
FROM oven/bun:latest AS builder

WORKDIR /build

# Copy package files first for better layer caching. The root package.json now declares
# Bun workspaces (apps/{ui,templates-ui,evals}), so their manifests + bunfig.toml (which pins
# linker="hoisted" — Bun defaults workspaces to "isolated", which would hide the root's
# phantom transitive deps and break the compile) must be present for the frozen install
# to resolve the workspace graph. Member deps land in the builder only; the final image
# copies just the compiled binary, so image size is unaffected.
COPY package.json bun.lock* bunfig.toml ./
COPY apps/ui/package.json ./apps/ui/package.json
COPY apps/templates-ui/package.json ./apps/templates-ui/package.json
COPY apps/evals/package.json ./apps/evals/package.json
RUN bun install --frozen-lockfile

# Copy source files
COPY src/ ./src/
COPY templates/ ./templates/
COPY tsconfig.json ./

# Pre-bundle script runtime files into self-contained JS bundles.
# The compiled API binary cannot share its /$bunfs/ virtual filesystem with
# spawned subprocesses — bun run /$bunfs/eval-harness.ts fails in the harness
# subprocess. Pre-building to real .js files on disk fixes this.
RUN mkdir -p scripts-runtime script-workflows-runtime && \
    bun build ./src/scripts-runtime/eval-harness.ts \
      --target bun --no-splitting \
      --outfile ./scripts-runtime/eval-harness.bundle.js && \
    bun build ./src/script-workflows/harness.ts \
      --target bun --no-splitting \
      --outfile ./script-workflows-runtime/harness.bundle.js && \
    bun build ./src/scripts-runtime/stdlib/index.ts \
      --target bun --no-splitting \
      --outfile ./scripts-runtime/stdlib.bundle.js && \
    bun build ./src/scripts-runtime/swarm-sdk.ts \
      --target bun --no-splitting \
      --outfile ./scripts-runtime/swarm-sdk.bundle.js && \
    bun build ./node_modules/zod/index.js \
      --target bun --no-splitting \
      --outfile ./scripts-runtime/zod.bundle.js

# Copy TypeScript lib .d.ts files for script typecheck in compiled binary mode.
# The compiled binary embeds .js modules in /$bunfs/ but not .d.ts files, so
# the TypeScript compiler can't load the default lib (Error, Number, etc.) without
# these real-filesystem copies.
RUN mkdir -p typescript-lib && cp node_modules/typescript/lib/lib.*.d.ts typescript-lib/

# Stage the `zod` declaration files for script typecheck in compiled-binary mode.
# `zod` is on the script import allowlist, but the compiled binary doesn't ship
# node_modules — so the TypeScript compiler can't resolve `import { z } from "zod"`
# without a real on-disk copy. Copy only the declaration files (mirrors the
# typescript-lib step above) to keep the runtime image slim.
RUN mkdir -p script-types/node_modules && cd node_modules && \
    find zod \( -name '*.d.ts' -o -name '*.d.cts' -o -name 'package.json' \) -print0 \
      | tar --null -cf - -T - \
      | tar -xf - -C /build/script-types/node_modules

# Compile HTTP server to standalone binary
RUN bun build ./src/http.ts --compile --compile-exec-argv='--expose-gc' --outfile ./agent-swarm-api

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

# Install minimal dependencies (for bun:sqlite and networking).
# python3 is required by the script-workflow executor's `python` runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    curl \
    jq \
    python3 \
    fuse3 libfuse2 \
    && rm -rf /var/lib/apt/lists/*

# Copy the bun CLI from the builder image so the script-workflow executor's
# `ts` runtime (`bun -e <script>`) works at runtime. The compiled API binary
# does not include the bun CLI itself.
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /build/agent-swarm-api /usr/local/bin/agent-swarm-api
RUN chmod +x /usr/local/bin/agent-swarm-api

# Copy package.json for version info
COPY package.json ./

# Copy migration SQL files (compiled binary can't read from /$bunfs virtual filesystem)
COPY src/be/migrations/*.sql /app/migrations/

# Copy vendored models.dev pricing snapshot so the compiled binary can seed
# pricing rows from a real filesystem path at runtime.
COPY src/be/modelsdev-cache.json /app/src/be/modelsdev-cache.json

# Curated OpenAPI snapshots are loaded by vendored script connections at runtime.
COPY vendored-openapi/ /app/vendored-openapi/

# Copy sqlite-vec native extension on real disk. `bun build --compile` embeds JS
# into /$bunfs/ but not native .so files, and dlopen can't load from /$bunfs/.
# The glob matches whichever arch-specific sqlite-vec optional dep bun installed
# for this build (sqlite-vec-linux-x64 or sqlite-vec-linux-arm64).
COPY --from=builder /build/node_modules/sqlite-vec-linux-*/vec0.so /app/extensions/vec0.so

# Copy script runtime bundles — needed by the harness subprocess.
# The compiled binary can't share its /$bunfs/ virtual filesystem with spawned
# bun processes, so these are pre-built real-filesystem .js files.
COPY --from=builder /build/scripts-runtime/ /app/scripts-runtime/

# Copy script workflow runtime bundle — needed by durable script-run subprocesses.
COPY --from=builder /build/script-workflows-runtime/ /app/script-workflows-runtime/

# Copy TypeScript lib .d.ts files for script typecheck in compiled binary mode.
COPY --from=builder /build/typescript-lib/ /app/typescript-lib/

# Copy staged `zod` declaration files for script typecheck in compiled binary
# mode. `zod` is on the script import allowlist; the compiled binary doesn't
# ship node_modules, so the TypeScript compiler resolves it from here instead.
COPY --from=builder /build/script-types/ /app/script-types/

# Install archil CLI for FUSE/R2-backed disk mounts
RUN curl https://s3.amazonaws.com/archil-client/install | sh

# Create data directory for SQLite (WAL mode needs .sqlite, .sqlite-wal, .sqlite-shm on same filesystem)
# Create Archil mount point directories
RUN mkdir -p /app/data /mnt/data /workspace/shared

ENV PORT=3013
ENV DATABASE_PATH=/app/data/agent-swarm-db.sqlite
ENV MIGRATIONS_DIR=/app/migrations
ENV SQLITE_VEC_EXTENSION_PATH=/app/extensions/vec0.so
ENV SCRIPT_RUNTIME_DIR=/app/scripts-runtime
ENV SCRIPT_WORKFLOW_RUNTIME_DIR=/app/script-workflows-runtime
ENV TS_LIB_DIR=/app/typescript-lib
ENV SCRIPT_TYPES_DIR=/app/script-types

VOLUME /app/data

EXPOSE 3013

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3013/health || exit 1

COPY api-entrypoint.sh /api-entrypoint.sh
RUN chmod +x /api-entrypoint.sh

ENTRYPOINT ["/api-entrypoint.sh"]
