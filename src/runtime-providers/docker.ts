import {
  type ConfigStatus,
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeHandle,
  type RuntimeProvider,
  type RuntimeStatus,
  type RuntimeTargetConfig,
} from "./types";

/**
 * Docker runtime provider. Talks to the Docker Engine API over the unix socket
 * with Bun's fetch (`unix:` option), so no dockerode dependency.
 *
 * Target config:
 * - DOCKER_HOST: `unix:///path/to/docker.sock` (default /var/run/docker.sock)
 * - DOCKER_NETWORK: optional network to attach runtimes to
 */
const API_VERSION = "v1.43";

function socketPath(target: RuntimeTargetConfig): string {
  const host = target.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  if (!host.startsWith("unix://")) {
    throw new Error(`docker provider only supports unix sockets, got DOCKER_HOST=${host}`);
  }
  return host.slice("unix://".length);
}

async function dockerApi<T>(
  target: RuntimeTargetConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://docker/${API_VERSION}${path}`, {
    method,
    unix: socketPath(target),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`docker ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class DockerRuntimeProvider implements RuntimeProvider {
  readonly kind = "docker" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: false };

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    try {
      socketPath(target);
      return { ready: true, missing: [] };
    } catch (err) {
      return { ready: false, missing: ["DOCKER_HOST"], hint: (err as Error).message };
    }
  }

  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    const created = await dockerApi<{ Id: string }>(
      target,
      "POST",
      `/containers/create?name=${encodeURIComponent(`swarm-rt-${req.runtimeId}`)}`,
      {
        Image: req.image,
        Env: Object.entries(req.env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          ...req.labels,
          [RUNTIME_LABELS.runtimeId]: req.runtimeId,
          [RUNTIME_LABELS.poolId]: req.poolId,
          [RUNTIME_LABELS.agentId]: req.agentId,
        },
        HostConfig: {
          // Lets a container reach an API on the docker host (compose-less installs).
          ExtraHosts: ["host.docker.internal:host-gateway"],
          NetworkMode: target.DOCKER_NETWORK,
          Memory: req.resources?.memoryMb ? req.resources.memoryMb * 1024 * 1024 : undefined,
          NanoCpus: req.resources?.cpu ? Math.round(req.resources.cpu * 1e9) : undefined,
        },
      },
    );
    await dockerApi(target, "POST", `/containers/${created.Id}/start`);
    return { kind: "docker", externalId: created.Id };
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    await dockerApi(target, "DELETE", `/containers/${handle.externalId}?force=true`);
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    try {
      const info = await dockerApi<{ State: { Status: string; ExitCode: number } }>(
        target,
        "GET",
        `/containers/${handle.externalId}/json`,
      );
      switch (info.State.Status) {
        case "created":
          return "starting";
        case "running":
        case "restarting":
          return "running";
        case "exited":
        case "dead":
          return info.State.ExitCode === 0 ? "exited" : "failed";
        default:
          return "unknown";
      }
    } catch {
      return "unknown";
    }
  }

  async list(target: RuntimeTargetConfig): Promise<RuntimeHandle[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [RUNTIME_LABELS.runtimeId] }));
    const rows = await dockerApi<Array<{ Id: string; Labels: Record<string, string> }>>(
      target,
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return rows.map((row) => ({ kind: "docker", externalId: row.Id, meta: row.Labels }));
  }
}
