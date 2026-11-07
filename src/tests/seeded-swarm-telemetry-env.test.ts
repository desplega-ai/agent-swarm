import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Test harnesses seed agent IDs under this prefix. A swarm that boots with one
// is test traffic, so it must tag its telemetry as test; otherwise it counts as
// a production install and pings the new-org alert.
const SEEDED_AGENT_PREFIX = "7a1e0000-0000-4000-8000-";

const REPO_ROOT = join(import.meta.dir, "..", "..");

type ComposeService = {
  build?: unknown;
  image?: string;
  environment?: string[] | Record<string, string | number | boolean | null>;
};

function serviceEnv(service: ComposeService): Record<string, string> {
  const env = service.environment;
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map((entry) => {
        const at = entry.indexOf("=");
        return at === -1 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
  }
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value ?? "")]));
}

// Services built from this repo's Dockerfiles run the API or a worker, both of
// which send telemetry. Third-party images (MinIO, agent-fs) do not.
function runsSwarm(service: ComposeService): boolean {
  return service.build !== undefined || (service.image ?? "").startsWith("swarm-");
}

const composeFiles = readdirSync(REPO_ROOT).filter((name) =>
  /^docker-compose.*\.ya?ml$/.test(name),
);

describe("compose launchers with seeded test agents", () => {
  test("every swarm service reports the test telemetry environment", async () => {
    const launchers: string[] = [];
    for (const name of composeFiles) {
      const compose = Bun.YAML.parse(await Bun.file(join(REPO_ROOT, name)).text()) as {
        services?: Record<string, ComposeService>;
      };
      const services = Object.entries(compose.services ?? {});
      const seeded = services.some(([, service]) =>
        serviceEnv(service).AGENT_ID?.startsWith(SEEDED_AGENT_PREFIX),
      );
      if (!seeded) continue;
      launchers.push(name);
      for (const [serviceName, service] of services) {
        if (!runsSwarm(service)) continue;
        expect({
          file: name,
          service: serviceName,
          env: serviceEnv(service).DESPLEGA_TELEMETRY_ENV,
        }).toEqual({
          file: name,
          service: serviceName,
          env: "test",
        });
      }
    }
    // Positive control: the scan must find the known launcher, or it checks nothing.
    expect(launchers).toContain("docker-compose.scripts-only.yml");
  });
});
