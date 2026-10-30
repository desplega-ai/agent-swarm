import { redactWithEnv } from "../e2b/env";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type ConfigStatus,
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeCacheReference,
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
const MAX_API_VERSION = 47;
const apiVersions = new Map<string, Promise<string>>();

async function apiVersion(socket: string): Promise<string> {
  let version = apiVersions.get(socket);
  if (!version) {
    version = (async () => {
      const response = await fetch("http://docker/_ping", { unix: socket } as RequestInit);
      if (!response.ok) {
        throw new DockerApiError(response.status, `docker ping failed: ${await response.text()}`);
      }
      const match = response.headers.get("Api-Version")?.match(/^1\.(\d+)$/);
      await response.text();
      return match ? `/v1.${Math.min(Number(match[1]), MAX_API_VERSION)}` : "";
    })();
    apiVersions.set(socket, version);
  }
  try {
    return await version;
  } catch (error) {
    apiVersions.delete(socket);
    throw error;
  }
}

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

function isCacheMountError(error: unknown): boolean {
  return error instanceof DockerApiError && /\b(?:mount\w*|volume\w*)\b/i.test(error.message);
}

type CacheVolume = { Name: string; Labels?: Record<string, string> };

function assertCacheOwner(volume: CacheVolume, cache: RuntimeCacheReference): void {
  if (
    volume.Name !== cache.key ||
    volume.Labels?.[RUNTIME_LABELS.owner] !== cache.ownerId ||
    volume.Labels?.[RUNTIME_LABELS.poolId] !== cache.poolId ||
    volume.Labels?.["swarm.cache"] !== "true"
  )
    throw new Error(`Cache volume ${cache.key} is not owned by this swarm and pool`);
}

async function dockerApi<T>(
  target: RuntimeTargetConfig,
  method: string,
  path: string,
  body?: unknown,
  stream = false,
  retryVersion = true,
): Promise<T> {
  const socket = socketPath(target);
  try {
    const version = await apiVersion(socket);
    const res = await fetch(`http://docker${version}${path}`, {
      method,
      unix: socket,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit);
    if (!res.ok) {
      const text = scrubSecrets(await res.text());
      if (
        retryVersion &&
        (/client version .* is too old/i.test(text) ||
          (res.status === 400 && /version/i.test(text)))
      ) {
        apiVersions.delete(socket);
        return await dockerApi<T>(target, method, path, body, stream, false);
      }
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
  readonly traits = {
    canProvision: true,
    ephemeralDisk: true,
    supportsPause: false,
    persistentCache: true,
  };

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
      let cacheWarning: string | undefined;
      let cacheMount: { Type: "volume"; Source: string; Target: string } | undefined;
      if (req.cache) {
        try {
          const volume = await dockerApi<CacheVolume>(target, "POST", "/volumes/create", {
            Name: req.cache.key,
            Labels: {
              [RUNTIME_LABELS.owner]: req.ownerId,
              [RUNTIME_LABELS.poolId]: req.poolId,
              "swarm.cache": "true",
            },
          });
          // Docker reuses an existing name without replacing its labels.
          assertCacheOwner(volume, {
            key: req.cache.key,
            poolId: req.poolId,
            ownerId: req.ownerId,
          });
          cacheMount = { Type: "volume", Source: req.cache.key, Target: req.cache.mountPath };
        } catch (error) {
          cacheWarning = redactWithEnv(scrubSecrets(String(error)), req.env);
        }
      }
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
          ...(cacheMount ? { Mounts: [cacheMount] } : {}),
        },
      };
      const createAndStart = async (): Promise<string> => {
        let created: { Id: string };
        try {
          created = await dockerApi(target, "POST", path, body);
        } catch (err) {
          if (
            !(err instanceof DockerApiError) ||
            err.statusCode !== 404 ||
            !err.message.includes("No such image")
          )
            throw err;
          const pullParams = new URLSearchParams({ fromImage: req.image });
          if (
            !req.image.includes("@") &&
            req.image.lastIndexOf(":") <= req.image.lastIndexOf("/")
          ) {
            pullParams.set("tag", "latest");
          }
          await dockerApi(target, "POST", `/images/create?${pullParams}`, undefined, true);
          created = await dockerApi(target, "POST", path, body);
        }
        try {
          await dockerApi(target, "POST", `/containers/${created.Id}/start`);
        } catch (err) {
          try {
            await dockerApi(target, "DELETE", `/containers/${created.Id}?force=true&v=true`);
          } catch (cleanupError) {
            if (
              cacheMount &&
              isCacheMountError(err) &&
              !(cleanupError instanceof DockerApiError && cleanupError.statusCode === 404)
            )
              throw new Error(
                `${String(err)}; failed-start cleanup failed: ${String(cleanupError)}`,
              );
          }
          throw err;
        }
        return created.Id;
      };
      let externalId: string;
      try {
        externalId = await createAndStart();
      } catch (err) {
        if (!cacheMount || !isCacheMountError(err)) throw err;
        cacheWarning = redactWithEnv(scrubSecrets(String(err)), req.env);
        delete body.HostConfig.Mounts;
        externalId = await createAndStart();
      }
      return {
        kind: "docker",
        externalId,
        ...(cacheWarning ? { meta: { cacheWarning } } : {}),
      };
    } catch (err) {
      throw new Error(redactWithEnv(String(err), req.env));
    }
  }

  async releaseCache(target: RuntimeTargetConfig, cache: RuntimeCacheReference): Promise<void> {
    const path = `/volumes/${encodeURIComponent(cache.key)}`;
    try {
      const volume = await dockerApi<CacheVolume>(target, "GET", path);
      assertCacheOwner(volume, cache);
      // A volume still attached to any container must remain intact (Docker returns 409).
      await dockerApi(target, "DELETE", path);
    } catch (error) {
      if (!(error instanceof DockerApiError && error.statusCode === 404)) throw error;
    }
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    try {
      // v=true also removes the container's anonymous volumes (the worker image declares
      // VOLUME /logs); named volumes are never removed by it.
      await dockerApi(target, "DELETE", `/containers/${handle.externalId}?force=true&v=true`);
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
