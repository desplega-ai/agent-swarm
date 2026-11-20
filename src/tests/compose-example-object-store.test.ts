import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The reference compose file is the self-host deployment the docs copy unchanged.
// Its object store must not ship a fixed login, and its ports stay on loopback
// unless the operator opts in.
const COMPOSE_PATH = join(import.meta.dir, "..", "..", "docker-compose.example.yml");

type Service = {
  environment?: Record<string, string> | string[];
  entrypoint?: string | string[];
  ports?: string[];
};

async function loadServices(): Promise<Record<string, Service>> {
  const doc = Bun.YAML.parse(await Bun.file(COMPOSE_PATH).text()) as {
    services: Record<string, Service>;
  };
  return doc.services;
}

function envOf(service: Service): Record<string, string> {
  const env = service.environment ?? {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(
    env.map((entry) => {
      const i = entry.indexOf("=");
      return [entry.slice(0, i), entry.slice(i + 1)];
    }),
  );
}

/** `${NAME:?...}`: compose refuses to start until the operator sets NAME. */
const REQUIRED_VAR = /^\$\{[A-Z0-9_]+:\?[^}]*\}$/;

describe("docker-compose.example.yml object store", () => {
  test("control: the file parses and the API key comes from the env", async () => {
    const services = await loadServices();
    expect(services.minio).toBeDefined();
    expect(services["agent-fs"]).toBeDefined();
    expect(envOf(services.api as Service).API_KEY).toMatch(/^\$\{API_KEY\}$/);
  });

  test("MinIO root login is a required env value, not a literal", async () => {
    const env = envOf((await loadServices()).minio as Service);
    expect(env.MINIO_ROOT_USER).toMatch(REQUIRED_VAR);
    expect(env.MINIO_ROOT_PASSWORD).toMatch(REQUIRED_VAR);
  });

  test("agent-fs and minio-init take the login from the env", async () => {
    const services = await loadServices();
    const agentFs = envOf(services["agent-fs"] as Service);
    expect(agentFs.S3_ACCESS_KEY_ID).toMatch(/^\$\{/);
    expect(agentFs.S3_SECRET_ACCESS_KEY).toMatch(/^\$\{/);
    const init = [services["minio-init"]?.entrypoint ?? ""].flat().join(" ");
    expect(init).not.toContain("minioadmin");
  });

  test("MinIO ports bind to loopback by default", async () => {
    const ports = (await loadServices()).minio?.ports ?? [];
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      // host:hostPort:containerPort, host defaulting to 127.0.0.1
      expect(port).toMatch(/^\$\{[A-Z0-9_]+:-127\.0\.0\.1\}:|^127\.0\.0\.1:/);
    }
  });
});
