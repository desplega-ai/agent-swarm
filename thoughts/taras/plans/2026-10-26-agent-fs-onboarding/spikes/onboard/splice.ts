// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
// Usage: bun splice.ts <generated.compose.yml> > <patched.compose.yml>
// Prototype of what generateCompose() would emit with the new-install flag on.
import { readFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const apiEnv = `      - AGENT_FS_API_URL=http://agent-fs:7433
      - AGENT_FS_PUBLIC_URL=\${AGENT_FS_PUBLIC_URL:-http://localhost:7433}
      - COMB_ENABLED=\${COMB_ENABLED:-true}
      - EMBEDDING_API_BASE_URL=http://tei:80/v1
      - EMBEDDING_MODEL=\${EMBEDDING_MODEL:-nomic-ai/nomic-embed-text-v1.5}
      - EMBEDDING_DIMENSIONS=\${EMBEDDING_DIMENSIONS:-768}
      - EMBEDDING_API_KEY=\${EMBEDDING_API_KEY:-local-tei}
      - ALLOW_PRIVATE_NETWORK_URLS=true
`;
const apiDeps = `    depends_on:
      agent-fs:
        condition: service_healthy
      tei:
        condition: service_healthy

`;
const services = `
  agent-fs:
    image: "ghcr.io/desplega-ai/agent-fs:0.18.5"
    container_name: swarm-agent-fs
    pull_policy: always
    environment:
      - AGENT_FS_HOME=/data
      - AGENT_FS_STORAGE_PROVIDER=local
      - AGENT_FS_LOCAL_ROOT=/data/storage
      - HOST=0.0.0.0
      - SERVER_HOST=0.0.0.0
      - PORT=7433
      - SERVER_PORT=7433
      - EMBEDDING_PROVIDER=\${AGENT_FS_EMBEDDING_PROVIDER:-local}
      - EMBEDDING_MODEL=\${AGENT_FS_EMBEDDING_MODEL:-}
      - EMBEDDING_API_KEY=\${AGENT_FS_EMBEDDING_API_KEY:-}
      - AGENT_FS_PUBLIC_URL=\${AGENT_FS_PUBLIC_URL:-http://localhost:7433}
    ports:
      - "\${AGENT_FS_PORT:-7433}:7433"
    volumes:
      - agent_fs_data:/data
    healthcheck:
      # No curl/wget in the agent-fs image (oven/bun slim). Probe with node fetch.
      test:
        [
          "CMD-SHELL",
          "node -e \\"fetch('http://127.0.0.1:7433/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\\"",
        ]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 10s
    restart: unless-stopped

  tei:
    # Per-arch tag cannot live in Compose: onboard writes TEI_IMAGE to .env on arm64.
    image: "\${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4}"
    container_name: swarm-tei
    pull_policy: always
    command: ["--model-id", "\${EMBEDDING_MODEL:-nomic-ai/nomic-embed-text-v1.5}"]
    volumes:
      - tei_data:/data
    healthcheck:
      # The TEI image ships curl (verified on cpu-arm64-1.9.4).
      test: ["CMD-SHELL", "curl -f http://localhost:80/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 60
      start_period: 20s
    restart: unless-stopped
`;
let out = src;
// swarm-api env: after the APP_URL line (first occurrence is swarm-api)
out = out.replace("      - APP_URL=https://app.agent-swarm.dev\n", (m) => m + apiEnv);
// swarm-api depends_on: before its `ports:` block (first occurrence)
out = out.replace("    ports:\n      - \"3013:3013\"", (m) => apiDeps.trimEnd() + "\n\n" + m);
// agent env
out = out.replace(/      - SWARM_URL=http:\/\/swarm-api:3013\n/g, (m) => m + "      - AGENT_FS_API_URL=http://agent-fs:7433\n");
// services before the volumes section
out = out.replace("\nvolumes:\n  swarm_data:", services + "\nvolumes:\n  agent_fs_data:\n  tei_data:\n  swarm_data:");
process.stdout.write(out);
