/**
 * Commands that start a first worker, shown in the header health popover.
 * Each one comes from the repo's own docs. Change them when the docs change:
 *
 * - compose: docs-site guides/deployment.mdx, "Step 5: Start the Swarm"
 *   (`docker compose up -d` next to docker-compose.yml). Both that file
 *   (docker-compose.example.yml) and the one install.sh generates read
 *   `${HARNESS_PROVIDER}` for every agent.
 * - docker: DEPLOYMENT.md, "Docker Worker > Run" (flags, volumes, image), with
 *   HARNESS_PROVIDER and MCP_BASE_URL (default http://host.docker.internal:3013)
 *   from docs-site guides/harness-configuration.mdx. DEPLOYMENT.md says to pin
 *   a release tag, so the tag is the API's version.
 * - kubernetes: docs-site guides/kubernetes.mdx (`helm upgrade` with the
 *   release, namespace and values file of the install, plus `--version`), with
 *   `pools.<name>.harnessProvider` from charts/agent-swarm/values.yaml.
 *
 * No command carries a credential. A worker without one still registers, then
 * waits until its login appears in swarm_config (docker-entrypoint.sh).
 */
import type { ProviderName } from "@/api/types";

const DOCS = "https://docs.agent-swarm.dev/docs/guides";

export const WORKER_TARGETS = [
  { value: "compose", label: "Compose" },
  { value: "docker", label: "Docker" },
  { value: "kubernetes", label: "Kubernetes" },
] as const;

export type WorkerTarget = (typeof WORKER_TARGETS)[number]["value"];

/** Where each target's command comes from, for the "Guide" link. */
export const WORKER_TARGET_DOCS: Record<WorkerTarget, string> = {
  compose: `${DOCS}/deployment#docker-compose-recommended`,
  docker: `${DOCS}/deployment#docker-worker-standalone`,
  kubernetes: `${DOCS}/kubernetes`,
};

/** The harnesses the /status harness hint offers, with the doc for their login. */
export const WORKER_HARNESSES: { value: ProviderName; loginDocs: string }[] = [
  { value: "claude", loginDocs: `${DOCS}/harness-configuration#claude-code-default` },
  { value: "codex", loginDocs: `${DOCS}/harness-configuration#codex` },
  { value: "opencode", loginDocs: `${DOCS}/harness-configuration#opencode` },
  { value: "pi", loginDocs: `${DOCS}/harness-configuration#pi-mono` },
  { value: "devin", loginDocs: `${DOCS}/harness-configuration#devin` },
  { value: "claude-managed", loginDocs: `${DOCS}/harness-configuration#claude-managed-agents` },
];

/** The documented default, for an API URL that a container cannot reach as is. */
const DOCKER_MCP_BASE_URL = "http://host.docker.internal:3013";

/** The dashboard's API URL as a container sees it: localhost means the host machine. */
function containerApiUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal";
    }
    return url.origin;
  } catch {
    return DOCKER_MCP_BASE_URL;
  }
}

export function workerStartCommand(
  target: WorkerTarget,
  harness: ProviderName,
  /** `version` is the API's version (`/health`), unknown while it loads. */
  context: { apiUrl: string; version?: string },
): string {
  if (target === "compose") return `HARNESS_PROVIDER=${harness} docker compose up -d`;
  if (target === "docker") {
    const image = "ghcr.io/desplega-ai/agent-swarm-worker";
    return [
      "docker run --rm -it \\",
      `  -e HARNESS_PROVIDER=${harness} \\`,
      `  -e MCP_BASE_URL=${containerApiUrl(context.apiUrl)} \\`,
      "  -e API_KEY=your-api-key \\",
      "  -v ./logs:/logs \\",
      "  -v ./work:/workspace \\",
      `  ${context.version ? `${image}:${context.version}` : image}`,
    ].join("\n");
  }
  return [
    "helm upgrade swarm oci://ghcr.io/desplega-ai/charts/agent-swarm \\",
    "  --namespace agent-swarm \\",
    "  --values swarm-values.yaml \\",
    ...(context.version ? [`  --version ${context.version} \\`] : []),
    `  --set pools.coder.harnessProvider=${harness}`,
  ].join("\n");
}
