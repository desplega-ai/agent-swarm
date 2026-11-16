# Phase 0 benchmark only. No API boot or shared database mounts.
# docker build -f scripts/bench-db-worker.Dockerfile -t db-worker-phase0:bench .
# docker run --rm --network none db-worker-phase0:bench --json
FROM oven/bun:1.4.4 AS builder
WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
COPY apps/ui/package.json ./apps/ui/package.json
COPY apps/templates-ui/package.json ./apps/templates-ui/package.json
COPY apps/evals/package.json ./apps/evals/package.json
COPY packages/model-catalog/package.json ./packages/model-catalog/package.json
COPY packages/model-routing/package.json ./packages/model-routing/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY scripts/bench-db-worker.ts scripts/bench-db-worker-thread.ts scripts/bench-db-worker-fixture.ts ./scripts/
COPY src/be/memory/constants.ts ./src/be/memory/constants.ts
RUN bun build --compile --compile-exec-argv='--expose-gc' ./scripts/bench-db-worker.ts ./scripts/bench-db-worker-thread.ts \
    --external sqlite-vec --outfile /build/db-worker-phase0

# Match the API runtime base. Native extensions must exist outside the compiled filesystem.
FROM debian:bookworm-slim
COPY --from=builder /build/db-worker-phase0 /usr/local/bin/db-worker-phase0
COPY --from=builder /build/node_modules/sqlite-vec-linux-*/vec0.so /opt/db-worker-phase0/vec0.so
ENV SQLITE_VEC_EXTENSION_PATH=/opt/db-worker-phase0/vec0.so
ENTRYPOINT ["/usr/local/bin/db-worker-phase0"]
