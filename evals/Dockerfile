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
#
# evals is a member of the root Bun workspace: its deps are recorded ONLY in the
# root bun.lock (there is no evals/bun.lock anymore). Install at the workspace
# root with every member manifest present, same preamble as the root Dockerfiles;
# the hoisted linker (bunfig.toml) puts node_modules at /app, where /app/evals
# resolves it up the tree — no symlink shim needed.
COPY package.json bun.lock bunfig.toml ./
COPY ui/package.json ./ui/
COPY templates-ui/package.json ./templates-ui/
COPY evals/package.json ./evals/
RUN bun install --frozen-lockfile

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
