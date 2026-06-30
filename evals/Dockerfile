FROM oven/bun:latest

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

ENV EVALS_PORT=4801 \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache

# Build with the repo root as context:
#   docker build -f evals/Dockerfile .
#
# The eval runner imports root src/e2b helpers and the models.dev pricing
# snapshot, so the image needs those repo-root files in addition to evals/.
COPY evals/package.json evals/bun.lock ./evals/
WORKDIR /app/evals
RUN bun install --frozen-lockfile
RUN ln -s /app/evals/node_modules /app/node_modules

WORKDIR /app
COPY evals ./evals
COPY src/e2b ./src/e2b
COPY src/utils ./src/utils
COPY src/be/modelsdev-cache.json ./src/be/modelsdev-cache.json

WORKDIR /app/evals
RUN bun run ui:build

ENV NODE_ENV=production

EXPOSE 4801
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const port = process.env.EVALS_PORT || '4801'; const res = await fetch('http://127.0.0.1:' + port + '/health'); if (!res.ok) process.exit(1)"

CMD ["bun", "src/cli.ts", "serve"]
