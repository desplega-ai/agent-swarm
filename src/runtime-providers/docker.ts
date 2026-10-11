import { redactWithEnv } from "../e2b/env";
import { scrubSecrets } from "../utils/secret-scrubber";
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
 * - DOCKER_EXTRA_HOSTS: comma-separated host:address entries
 */
const API_VERSION = "v1.43";

function socketPath(target: RuntimeTargetConfig): string {
  const host = target.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  if (!host.startsWith("unix://")) {
    throw new Error(
      scrubSecrets(`docker provider only supports unix sockets, got DOCKER_HOST=${host}`),
    );
  }
  return host.slice("unix://".length);
}

class DockerApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(scrubSecrets(message));
  }
}

async function dockerApi<T>(
  target: RuntimeTargetConfig,
  method: string,
  path: string,
  body?: unknown,
  stream = false,
): Promise<T> {
  const socket = socketPath(target);
  try {
    const res = await fetch(`http://docker/${API_VERSION}${path}`, {
      method,
      unix: socket,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit);
    if (!res.ok) {
      const text = scrubSecrets(await res.text());
      throw new DockerApiError(
        res.status,
        `docker ${method} ${path} failed (${res.status}): ${text}`,
      );
    }
    if (res.status === 204 || res.status === 304) return undefined as T;
    const text = await res.text();
    if (stream) {
      for (const line of text.split("\n").filter((line) => line.trim())) {
        const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
        if (event.error || event.errorDetail?.message) {
          throw new Error(event.error ?? event.errorDetail?.message);
        }
      }
      return undefined as T;
    }
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (err) {
    if (err instanceof DockerApiError) throw err;
    throw new Error(
      scrubSecrets(
        `docker ${method} ${path} via socket ${socket}: ${String(err)}. Set DOCKER_HOST to select the Docker socket.`,
      ),
    );
  }
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
    try {
      const path = `/containers/create?name=${encodeURIComponent(`swarm-rt-${req.runtimeId}`)}`;
      const body = {
        Image: req.image,
        Env: Object.entries(req.env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          ...req.labels,
          [RUNTIME_LABELS.owner]: req.ownerId,
          [RUNTIME_LABELS.runtimeId]: req.runtimeId,
          [RUNTIME_LABELS.poolId]: req.poolId,
          [RUNTIME_LABELS.agentId]: req.agentId,
        },
        HostConfig: {
          // Lets a container reach an API on the docker host (compose-less installs).
          ExtraHosts: [
            "host.docker.internal:host-gateway",
            ...(target.DOCKER_EXTRA_HOSTS?.split(",")
              .map((host) => host.trim())
              .filter(Boolean) ?? []),
          ],
          NetworkMode: target.DOCKER_NETWORK,
          Memory: req.resources?.memoryMb ? req.resources.memoryMb * 1024 * 1024 : undefined,
          NanoCpus: req.resources?.cpu ? Math.round(req.resources.cpu * 1e9) : undefined,
        },
      };
      let created: { Id: string };
      try {
        created = await dockerApi(target, "POST", path, body);
      } catch (err) {
        if (
          !(err instanceof DockerApiError) ||
          err.statusCode !== 404 ||
          !err.message.includes("No such image")
        ) {
          throw err;
        }
        const pullParams = new URLSearchParams({ fromImage: req.image });
        if (!req.image.includes("@") && req.image.lastIndexOf(":") <= req.image.lastIndexOf("/")) {
          pullParams.set("tag", "latest");
        }
        await dockerApi(target, "POST", `/images/create?${pullParams}`, undefined, true);
        created = await dockerApi(target, "POST", path, body);
      }
      try {
        await dockerApi(target, "POST", `/containers/${created.Id}/start`);
      } catch (err) {
        await dockerApi(target, "DELETE", `/containers/${created.Id}?force=true`).catch(() => {});
        throw err;
      }
      return { kind: "docker", externalId: created.Id };
    } catch (err) {
      throw new Error(redactWithEnv(String(err), req.env));
    }
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    try {
      await dockerApi(target, "DELETE", `/containers/${handle.externalId}?force=true`);
    } catch (err) {
      if (!(err instanceof DockerApiError) || err.statusCode !== 404) throw err;
    }
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
    } catch (err) {
      return err instanceof DockerApiError && err.statusCode === 404 ? "exited" : "unknown";
    }
  }

  async list(target: RuntimeTargetConfig, ownerId: string): Promise<RuntimeHandle[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [RUNTIME_LABELS.runtimeId, `${RUNTIME_LABELS.owner}=${ownerId}`] }),
    );
    const rows = await dockerApi<
      Array<{ Id: string; Created?: number; Labels: Record<string, string> }>
    >(target, "GET", `/containers/json?all=true&filters=${filters}`);
    return rows.map((row) => ({
      kind: "docker",
      externalId: row.Id,
      createdAt: row.Created === undefined ? undefined : new Date(row.Created * 1000).toISOString(),
      meta: row.Labels,
    }));
  }
}
