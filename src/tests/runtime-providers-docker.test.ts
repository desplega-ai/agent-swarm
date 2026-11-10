import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntimeProvider } from "../runtime-providers/docker";
import {
  type ProvisionRequest,
  RUNTIME_LABELS,
  WORKSPACE_LABEL,
  workspaceVolumeKey,
} from "../runtime-providers/types";
import { scrubSecrets } from "../utils/secret-scrubber";

const provider = new DockerRuntimeProvider();
let target: { DOCKER_HOST: string };
const handle = { kind: "docker" as const, externalId: "container-1" };
const request: ProvisionRequest = {
  runtimeId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  poolId: "pool-1",
  ownerId: "owner-1",
  image: "worker:test",
  env: { AGENT_ROLE: "worker" },
  labels: { custom: "value", [RUNTIME_LABELS.owner]: "spoofed-owner" },
  resources: { cpu: 0.5, memoryMb: 128 },
};

type EngineHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: EngineHandler;
let calls: Array<{ url: URL; init: RequestInit }>;
let server: Bun.Server<undefined>;
let socket: string;
let serverVersion: string | undefined;
let pings: string[];

beforeEach(() => {
  calls = [];
  pings = [];
  serverVersion = "1.51";
  handler = () => Response.json({ Id: handle.externalId });
  socket = join(tmpdir(), `rp-${crypto.randomUUID().slice(0, 16)}.sock`);
  target = { DOCKER_HOST: `unix://${socket}` };
  server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/_ping") {
        pings.push(req.method);
        return new Response("OK", {
          headers: serverVersion ? { "Api-Version": serverVersion } : {},
        });
      }
      const init = { method: req.method, body: await req.text() };
      calls.push({ url, init });
      return handler(url, init);
    },
  });
});

afterEach(async () => {
  await server.stop(true);
  await Bun.file(socket)
    .delete()
    .catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
});

describe("Docker runtime provider", () => {
  for (const failureAt of ["create", "start"] as const) {
    test(`cache mount failure during container ${failureAt} retries once without cache`, async () => {
      const bodies: Array<{ HostConfig: { Mounts?: unknown }; Env: string[] }> = [];
      const secret = "mount-failure-private-token";
      handler = (url, init) => {
        if (url.pathname.endsWith("/volumes/create"))
          return Response.json(JSON.parse(String(init.body)));
        if (url.pathname.endsWith("/containers/create")) {
          bodies.push(JSON.parse(String(init.body)));
          if (bodies.length === 1 && failureAt === "create")
            return Response.json({ message: `invalid mount config ${secret}` }, { status: 500 });
          return Response.json({ Id: `container-${bodies.length}` });
        }
        if (url.pathname.endsWith("/container-1/start") && failureAt === "start")
          return Response.json(
            { message: `error while mounting volume ${secret}` },
            { status: 500 },
          );
        return new Response(null, { status: 204 });
      };
      const result = await provider.provision(target, {
        ...request,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
        env: { API_KEY: secret },
      });
      expect(result.externalId).toBe("container-2");
      expect(result.meta?.cacheWarning).toContain("mount");
      expect(result.meta?.cacheWarning).not.toContain(secret);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.HostConfig.Mounts).toBeDefined();
      expect(bodies[1]?.HostConfig.Mounts).toBeUndefined();
      expect(bodies[1]?.Env).toEqual([`API_KEY=${secret}`]);
      const operations = calls.map(({ url, init }) => `${init.method} ${url.pathname}`);
      if (failureAt === "start")
        expect(operations.indexOf("DELETE /v1.47/containers/container-1")).toBeLessThan(
          operations.lastIndexOf("POST /v1.47/containers/create"),
        );
      expect(operations.at(-1)).toBe("POST /v1.47/containers/container-2/start");
    });
  }

  test("unrelated container errors never trigger a cache fallback", async () => {
    handler = (url, init) =>
      url.pathname.endsWith("/volumes/create")
        ? Response.json(JSON.parse(String(init.body)))
        : Response.json({ message: "network not found" }, { status: 500 });
    await expect(
      provider.provision(target, {
        ...request,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      }),
    ).rejects.toThrow("network not found");
    expect(calls.filter(({ url }) => url.pathname.endsWith("/containers/create"))).toHaveLength(1);
  });

  test("a failed cleanup after a mount start error prevents a duplicate container attempt", async () => {
    handler = (url, init) => {
      if (url.pathname.endsWith("/volumes/create"))
        return Response.json(JSON.parse(String(init.body)));
      if (url.pathname.endsWith("/containers/create"))
        return Response.json({ Id: handle.externalId });
      return Response.json(
        { message: init.method === "DELETE" ? "cleanup unavailable" : "volume mount failed" },
        { status: 500 },
      );
    };
    await expect(
      provider.provision(target, {
        ...request,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      }),
    ).rejects.toThrow("failed-start cleanup failed");
    expect(calls.filter(({ url }) => url.pathname.endsWith("/containers/create"))).toHaveLength(1);
  });

  test("cache-free retry errors propagate without a third attempt", async () => {
    let creates = 0;
    handler = (url, init) =>
      url.pathname.endsWith("/volumes/create")
        ? Response.json(JSON.parse(String(init.body)))
        : Response.json(
            { message: ++creates === 1 ? "volume mount failed" : "daemon unavailable" },
            { status: 500 },
          );
    await expect(
      provider.provision(target, {
        ...request,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      }),
    ).rejects.toThrow("daemon unavailable");
    expect(creates).toBe(2);
  });

  test("cache release verifies ownership and never forces removal", async () => {
    const cache = { key: "swarm-cache-pool-1", poolId: request.poolId, ownerId: request.ownerId };
    handler = (_url, init) =>
      init.method === "GET"
        ? Response.json({
            Name: cache.key,
            Labels: {
              [RUNTIME_LABELS.owner]: cache.ownerId,
              [RUNTIME_LABELS.poolId]: cache.poolId,
              "swarm.cache": "true",
            },
          })
        : new Response(null, { status: 204 });
    await provider.releaseCache(target, cache);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "DELETE"]);
    expect(calls[1]?.url.searchParams.has("force")).toBe(false);
    calls = [];
    handler = () => Response.json({ Name: cache.key, Labels: {} });
    await expect(provider.releaseCache(target, cache)).rejects.toThrow("not owned");
    expect(calls).toHaveLength(1);
  });

  test("cache release tolerates missing volumes and defers in-use volumes", async () => {
    const cache = { key: "swarm-cache-pool-1", poolId: request.poolId, ownerId: request.ownerId };
    handler = () => new Response("missing", { status: 404 });
    await provider.releaseCache(target, cache);
    handler = (_url, init) =>
      init.method === "GET"
        ? Response.json({
            Name: cache.key,
            Labels: {
              [RUNTIME_LABELS.owner]: cache.ownerId,
              [RUNTIME_LABELS.poolId]: cache.poolId,
              "swarm.cache": "true",
            },
          })
        : new Response("volume is in use", { status: 409 });
    await expect(provider.releaseCache(target, cache)).rejects.toThrow("volume is in use");
  });

  test("cache release refuses a volume labelled as a workspace", async () => {
    const cache = { key: "swarm-cache-pool-1", poolId: request.poolId, ownerId: request.ownerId };
    handler = (_url, init) =>
      init.method === "GET"
        ? Response.json({
            Name: cache.key,
            Labels: {
              [RUNTIME_LABELS.owner]: cache.ownerId,
              [RUNTIME_LABELS.poolId]: cache.poolId,
              "swarm.cache": "true",
              "swarm.workspace": "true",
            },
          })
        : new Response(null, { status: 204 });
    calls = [];
    await expect(provider.releaseCache(target, cache)).rejects.toThrow("not owned");
    expect(calls.map(({ init }) => init.method)).toEqual(["GET"]);
  });

  test("cache volumes are shared across runtimes and survive container termination", async () => {
    const volumes = new Map<
      string,
      { Name: string; Labels: Record<string, string>; content: string }
    >();
    const mounts: unknown[] = [];
    handler = (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname.endsWith("/volumes/create")) {
        if (!volumes.has(body.Name)) volumes.set(body.Name, { ...body, content: "" });
        return Response.json(volumes.get(body.Name));
      }
      if (url.pathname.endsWith("/containers/create")) {
        mounts.push(body.HostConfig.Mounts);
        return Response.json({ Id: crypto.randomUUID() });
      }
      return new Response(null, { status: 204 });
    };
    const cache = { key: "swarm-cache-pool-1", mountPath: "/cache" };
    const first = await provider.provision(target, { ...request, cache });
    volumes.get(cache.key)!.content = "cached git objects";
    await provider.terminate(target, first);
    const second = await provider.provision(target, {
      ...request,
      runtimeId: crypto.randomUUID(),
      cache,
    });
    await provider.terminate(target, second);
    expect(volumes.size).toBe(1);
    expect(volumes.get(cache.key)?.content).toBe("cached git objects");
    expect(volumes.get(cache.key)?.Labels).toEqual({
      [RUNTIME_LABELS.owner]: request.ownerId,
      [RUNTIME_LABELS.poolId]: request.poolId,
      "swarm.cache": "true",
    });
    expect(mounts).toEqual(
      Array(2).fill([{ Type: "volume", Source: cache.key, Target: "/cache" }]),
    );
    expect(
      calls
        .filter(({ init }) => init.method === "DELETE")
        .every(
          ({ url }) =>
            url.pathname.includes("/containers/") && url.searchParams.get("v") === "true",
        ),
    ).toBe(true);
    expect(provider.traits).toMatchObject({ persistentCache: true, ephemeralDisk: true });
  });

  test("cache provisioning fails open with a scrubbed warning and no mount", async () => {
    const secret = "cache-volume-short-secret";
    handler = (url) =>
      url.pathname.endsWith("/volumes/create")
        ? new Response(`volume unavailable ${secret}`, { status: 500 })
        : url.pathname.endsWith("/containers/create")
          ? Response.json({ Id: handle.externalId })
          : new Response(null, { status: 204 });
    const result = await provider.provision(target, {
      ...request,
      cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      env: { API_KEY: secret },
    });
    expect(result.meta?.cacheWarning).toContain("volume unavailable");
    expect(result.meta?.cacheWarning).not.toContain(secret);
    const body = JSON.parse(
      String(calls.find(({ url }) => url.pathname.endsWith("/containers/create"))?.init.body),
    );
    expect(body.HostConfig.Mounts).toBeUndefined();
    expect(calls.at(-1)?.url.pathname).toEndWith("/containers/container-1/start");
  });

  for (const mismatched of ["owner", "poolId", "cache"] as const) {
    test(`cache volumes with a mismatched ${mismatched} label are never mounted or relabeled`, async () => {
      const labels = {
        [RUNTIME_LABELS.owner]: request.ownerId,
        [RUNTIME_LABELS.poolId]: request.poolId,
        "swarm.cache": "true",
      };
      labels[mismatched === "cache" ? "swarm.cache" : RUNTIME_LABELS[mismatched]] = "foreign";
      handler = (url) =>
        url.pathname.endsWith("/volumes/create")
          ? Response.json({ Name: "swarm-cache-pool-1", Labels: labels })
          : url.pathname.endsWith("/containers/create")
            ? Response.json({ Id: handle.externalId })
            : new Response(null, { status: 204 });
      const result = await provider.provision(target, {
        ...request,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      });
      expect(result.meta?.cacheWarning).toContain("not owned");
      expect(JSON.parse(String(calls[1]?.init.body)).HostConfig.Mounts).toBeUndefined();
      expect(calls.some(({ init }) => init.method === "DELETE")).toBe(false);
    });
  }

  test("cache mounts survive the missing-image retry", async () => {
    let creates = 0;
    handler = (url, init) => {
      if (url.pathname.endsWith("/volumes/create"))
        return Response.json(JSON.parse(String(init.body)));
      if (url.pathname.endsWith("/containers/create")) {
        expect(JSON.parse(String(init.body)).HostConfig.Mounts).toEqual([
          { Type: "volume", Source: "swarm-cache-pool-1", Target: "/cache" },
        ]);
        return ++creates === 1
          ? new Response("No such image", { status: 404 })
          : Response.json({ Id: handle.externalId });
      }
      return url.pathname.endsWith("/images/create")
        ? new Response('{"status":"complete"}\n')
        : new Response(null, { status: 204 });
    };
    await provider.provision(target, {
      ...request,
      cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
    });
    expect(creates).toBe(2);
    expect(calls.filter(({ url }) => url.pathname.endsWith("/volumes/create"))).toHaveLength(1);
  });

  for (const message of [
    "client version 1.44 is too old. Minimum supported API version is 1.47",
    "API version is unsupported",
  ]) {
    test(`renegotiates a rejected version once: ${message}`, async () => {
      serverVersion = "1.44";
      let attempts = 0;
      handler = () => {
        serverVersion = "1.51";
        return ++attempts === 1
          ? Response.json({ message }, { status: 400 })
          : new Response(null, { status: 204 });
      };
      await provider.terminate(target, handle);
      expect(pings).toEqual(["GET", "GET"]);
      expect(calls.map(({ url }) => url.pathname)).toEqual([
        "/v1.44/containers/container-1",
        "/v1.47/containers/container-1",
      ]);
      await provider.terminate(target, handle);
      expect(pings).toHaveLength(2);
    });
  }

  test("does not retry a version error more than once", async () => {
    handler = () => Response.json({ message: "client version 1.47 is too old" }, { status: 400 });
    await expect(provider.terminate(target, handle)).rejects.toThrow("too old");
    expect(pings).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  test("does not renegotiate unrelated HTTP 400 errors", async () => {
    handler = () => new Response("Invalid container", { status: 400 });
    await expect(provider.terminate(target, handle)).rejects.toThrow("Invalid container");
    expect(pings).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  for (const [version, prefix] of [
    ["1.51", "/v1.47"],
    ["1.44", "/v1.44"],
    [undefined, ""],
  ] as const) {
    test(`negotiates ${version ?? "a missing API header"} and caches the version per socket`, async () => {
      serverVersion = version;
      handler = () => new Response(null, { status: 204 });
      await Promise.all([provider.terminate(target, handle), provider.terminate(target, handle)]);
      serverVersion = "1.50";
      await provider.terminate(target, handle);
      expect(pings).toEqual(["GET"]);
      expect(calls.map(({ url }) => url.pathname)).toEqual(
        Array(3).fill(`${prefix}/containers/container-1`),
      );
    });
  }

  test("creates and starts a container with authoritative labels and host configuration", async () => {
    expect(
      await provider.provision(
        {
          ...target,
          DOCKER_NETWORK: "swarm-net",
          DOCKER_EXTRA_HOSTS: " service:10.1.0.2, ,other:10.1.0.3 ",
        },
        request,
      ),
    ).toEqual(handle);
    expect(calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual([
      "POST /v1.47/containers/create",
      "POST /v1.47/containers/container-1/start",
    ]);
    expect(calls[0]?.url.searchParams.get("name")).toBe(`swarm-rt-${request.runtimeId}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      Image: request.image,
      Env: ["AGENT_ROLE=worker"],
      Labels: {
        custom: "value",
        [RUNTIME_LABELS.owner]: request.ownerId,
        [RUNTIME_LABELS.runtimeId]: request.runtimeId,
        [RUNTIME_LABELS.agentId]: request.agentId,
        [RUNTIME_LABELS.poolId]: request.poolId,
      },
      HostConfig: {
        ExtraHosts: ["host.docker.internal:host-gateway", "service:10.1.0.2", "other:10.1.0.3"],
        NetworkMode: "swarm-net",
        Memory: 128 * 1024 * 1024,
        NanoCpus: 500_000_000,
      },
    });
  });

  test("a request without a workspace sends the same create body bytes as before", async () => {
    await provider.provision(target, request);
    expect(calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual([
      "POST /v1.47/containers/create",
      "POST /v1.47/containers/container-1/start",
    ]);
    expect(String(calls[0]?.init.body)).toBe(
      JSON.stringify({
        Image: request.image,
        Env: ["AGENT_ROLE=worker"],
        Labels: {
          custom: "value",
          [RUNTIME_LABELS.owner]: request.ownerId,
          [RUNTIME_LABELS.runtimeId]: request.runtimeId,
          [RUNTIME_LABELS.poolId]: request.poolId,
          [RUNTIME_LABELS.agentId]: request.agentId,
        },
        HostConfig: {
          ExtraHosts: ["host.docker.internal:host-gateway"],
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500_000_000,
        },
      }),
    );
  });

  describe("persistent workspace", () => {
    const key = workspaceVolumeKey(request.agentId, 0);
    const workspaceRequest = { ...request, workspace: { key } };
    const ownedLabels = {
      [RUNTIME_LABELS.owner]: request.ownerId,
      [RUNTIME_LABELS.agentId]: request.agentId,
      [WORKSPACE_LABEL]: "true",
    };
    const workspaceMount = { Type: "volume", Source: key, Target: "/workspace/personal" };
    let volumes: Map<string, { Name: string; Labels: Record<string, string> }>;
    let users: Array<{ Id: string; State: string }>;
    let createBodies: Array<{ HostConfig: { Mounts?: unknown[] } }>;
    let createFailure: ((attempt: number) => Response | undefined) | undefined;

    beforeEach(() => {
      volumes = new Map();
      users = [];
      createBodies = [];
      createFailure = undefined;
      handler = (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (url.pathname.endsWith("/volumes/create")) {
          if (!volumes.has(body.Name)) volumes.set(body.Name, body);
          return Response.json(volumes.get(body.Name));
        }
        if (url.pathname.endsWith("/containers/json")) return Response.json(users);
        if (url.pathname.endsWith("/containers/create")) {
          createBodies.push(body);
          return createFailure?.(createBodies.length) ?? Response.json({ Id: handle.externalId });
        }
        return new Response(null, { status: 204 });
      };
    });

    test("creates an agent-owned volume, mounts it at /workspace/personal and echoes the key", async () => {
      const result = await provider.provision(target, workspaceRequest);
      expect(result.meta).toEqual({ workspaceKey: key });
      expect(volumes.get(key)?.Labels).toEqual(ownedLabels);
      expect(createBodies[0]?.HostConfig.Mounts).toEqual([workspaceMount]);
      const lookup = calls.find(({ url }) => url.pathname.endsWith("/containers/json"));
      expect(JSON.parse(lookup?.url.searchParams.get("filters") ?? "{}")).toEqual({
        volume: [key],
      });
      expect(provider.traits.persistentWorkspace).toBe(true);
    });

    test("reuses an owned volume across runtimes and terminate never deletes it", async () => {
      const first = await provider.provision(target, workspaceRequest);
      users = [{ Id: first.externalId, State: "exited" }];
      await provider.terminate(target, first);
      await provider.provision(target, { ...workspaceRequest, runtimeId: crypto.randomUUID() });
      expect(volumes.size).toBe(1);
      expect(createBodies.map((b) => b.HostConfig.Mounts)).toEqual([
        [workspaceMount],
        [workspaceMount],
      ]);
      expect(
        calls.some(
          ({ url, init }) => init.method === "DELETE" && url.pathname.includes("/volumes"),
        ),
      ).toBe(false);
    });

    test("rejects a volume with foreign labels", async () => {
      volumes.set(key, { Name: key, Labels: { ...ownedLabels, [RUNTIME_LABELS.owner]: "other" } });
      await expect(provider.provision(target, workspaceRequest)).rejects.toThrow("not owned");
      expect(createBodies).toHaveLength(0);
    });

    for (const State of ["running", "restarting", "paused", "created"])
      test(`rejects a volume a ${State} container still mounts`, async () => {
        users = [{ Id: "previous", State }];
        await expect(provider.provision(target, workspaceRequest)).rejects.toThrow(
          `workspace ${key} is in use by previous`,
        );
        expect(createBodies).toHaveLength(0);
      });

    test("mounts the cache and the workspace together", async () => {
      await provider.provision(target, {
        ...workspaceRequest,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      });
      expect(createBodies[0]?.HostConfig.Mounts).toEqual([
        { Type: "volume", Source: "swarm-cache-pool-1", Target: "/cache" },
        workspaceMount,
      ]);
    });

    test("a cache mount error retries without the cache but keeps the workspace", async () => {
      createFailure = (attempt) =>
        attempt === 1
          ? Response.json({ message: "invalid mount config" }, { status: 500 })
          : undefined;
      const result = await provider.provision(target, {
        ...workspaceRequest,
        cache: { key: "swarm-cache-pool-1", mountPath: "/cache" },
      });
      expect(result.meta?.workspaceKey).toBe(key);
      expect(result.meta?.cacheWarning).toContain("mount");
      expect(createBodies.at(-1)?.HostConfig.Mounts).toEqual([workspaceMount]);
    });

    test("a workspace mount error fails the provision without a workspace-free retry", async () => {
      createFailure = () => Response.json({ message: "invalid mount config" }, { status: 500 });
      await expect(provider.provision(target, workspaceRequest)).rejects.toThrow("mount");
      expect(createBodies).toHaveLength(1);
    });

    test("a volume create error fails the provision instead of starting without it", async () => {
      handler = (url) =>
        url.pathname.endsWith("/volumes/create")
          ? new Response("disk full", { status: 500 })
          : Response.json({ Id: handle.externalId });
      await expect(provider.provision(target, workspaceRequest)).rejects.toThrow("disk full");
      expect(calls.some(({ url }) => url.pathname.endsWith("/containers/create"))).toBe(false);
    });
  });

  const createBody = () =>
    JSON.parse(String(calls[0]?.init.body)) as { HostConfig: Record<string, unknown> };

  test("isolation keys are absent from the create request by default", async () => {
    await provider.provision(target, request);
    const hostConfig = createBody().HostConfig;
    for (const key of ["Runtime", "PidsLimit", "CapDrop", "CapAdd", "SecurityOpt", "MemorySwap"])
      expect(hostConfig).not.toHaveProperty(key);
    expect(Object.keys(hostConfig).sort()).toEqual(["ExtraHosts", "Memory", "NanoCpus"]);
  });

  test("DOCKER_RUNTIME and DOCKER_PIDS_LIMIT map to HostConfig fields", async () => {
    await provider.provision(
      { ...target, DOCKER_RUNTIME: " runsc ", DOCKER_PIDS_LIMIT: "256" },
      request,
    );
    expect(createBody().HostConfig).toMatchObject({ Runtime: "runsc", PidsLimit: 256 });
    expect(createBody().HostConfig).not.toHaveProperty("CapDrop");
  });

  test("DOCKER_HARDENED drops capabilities, forbids escalation, and disables swap", async () => {
    await provider.provision({ ...target, DOCKER_HARDENED: "true" }, request);
    expect(createBody().HostConfig).toEqual({
      ExtraHosts: ["host.docker.internal:host-gateway"],
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL"],
      SecurityOpt: ["no-new-privileges:true"],
    });
  });

  test("DOCKER_HARDENED sets MemorySwap only when memory is limited", async () => {
    await provider.provision(
      { ...target, DOCKER_HARDENED: "true" },
      { ...request, resources: { cpu: 1 } },
    );
    const hostConfig = createBody().HostConfig;
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(hostConfig).not.toHaveProperty("Memory");
    expect(hostConfig).not.toHaveProperty("MemorySwap");
  });

  // Same parse as every other boolean setting (parseEnvFlag): true/1, any case.
  for (const value of ["1", "TRUE", " true "]) {
    test(`DOCKER_HARDENED=${JSON.stringify(value)} turns the profile on`, async () => {
      await provider.provision({ ...target, DOCKER_HARDENED: value }, request);
      expect(createBody().HostConfig.CapDrop).toEqual(["ALL"]);
    });
  }

  for (const value of ["false", "0", "yes", ""]) {
    test(`DOCKER_HARDENED=${JSON.stringify(value)} leaves the profile off`, async () => {
      await provider.provision({ ...target, DOCKER_HARDENED: value }, request);
      expect(createBody().HostConfig).not.toHaveProperty("CapDrop");
      expect(createBody().HostConfig).not.toHaveProperty("MemorySwap");
    });
  }

  for (const [key, value] of [
    ["DOCKER_PIDS_LIMIT", "0"],
    ["DOCKER_PIDS_LIMIT", "-5"],
    ["DOCKER_PIDS_LIMIT", "12abc"],
    ["DOCKER_PIDS_LIMIT", "1.5"],
    ["DOCKER_PIDS_LIMIT", "99999999999999999999"],
    ["DOCKER_RUNTIME", "run sc"],
    ["DOCKER_RUNTIME", "../runsc"],
    ["DOCKER_RUNTIME", "runsc;rm"],
  ] as const) {
    test(`rejects ${key}=${JSON.stringify(value)} in checkConfig and before any Docker call`, async () => {
      const status = provider.checkConfig({ ...target, [key]: value });
      expect(status.ready).toBe(false);
      expect(status.missing).toEqual([key]);
      expect(status.hint).toContain(key);
      await expect(provider.provision({ ...target, [key]: value }, request)).rejects.toThrow(key);
      expect(calls).toHaveLength(0);
    });
  }

  test("checkConfig accepts valid isolation keys", () => {
    expect(
      provider.checkConfig({
        ...target,
        DOCKER_RUNTIME: "io.containerd.runsc.v1",
        DOCKER_HARDENED: "true",
        DOCKER_PIDS_LIMIT: "512",
      }),
    ).toEqual({ ready: true, missing: [] });
  });

  test("pulls a missing image and waits for the stream before retrying creation", async () => {
    let creates = 0;
    let finishPull!: () => void;
    let beginPull!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      beginPull = resolve;
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"Pulling"}\n'));
        finishPull = () => {
          controller.enqueue(new TextEncoder().encode('{"status":"Complete"}\n'));
          controller.close();
        };
      },
    });
    handler = (url) => {
      if (url.pathname.endsWith("/containers/create")) {
        creates++;
        return creates === 1
          ? Response.json({ message: "No such image: worker:test" }, { status: 404 })
          : Response.json({ Id: handle.externalId });
      }
      if (url.pathname.endsWith("/images/create")) {
        expect(url.searchParams.get("fromImage")).toBe(request.image);
        beginPull();
        return new Response(stream);
      }
      return new Response(null, { status: 204 });
    };
    const provisioning = provider.provision(target, request);
    await pullStarted;
    expect(creates).toBe(1);
    finishPull();
    expect(await provisioning).toEqual(handle);
    expect(creates).toBe(2);
    expect(calls).toHaveLength(4);
  });

  test("retries creation only once after pulling", async () => {
    handler = (url) =>
      url.pathname.endsWith("/images/create")
        ? new Response('{"status":"Complete"}\n')
        : Response.json({ message: "No such image" }, { status: 404 });
    await expect(provider.provision(target, request)).rejects.toThrow("No such image");
    expect(calls).toHaveLength(3);
  });

  test("pulls latest for untagged images without confusing registry ports with tags", async () => {
    for (const [image, tag] of [
      ["ghcr.io/org/worker", "latest"],
      ["worker", "latest"],
      ["host:5000/img", "latest"],
      ["host:5000/img:test", null],
      ["host:5000/img@sha256:abc123", null],
    ] as const) {
      let creates = 0;
      handler = (url) => {
        if (url.pathname.endsWith("/containers/create")) {
          return ++creates === 1
            ? Response.json({ message: "No such image" }, { status: 404 })
            : Response.json({ Id: handle.externalId });
        }
        if (url.pathname.endsWith("/images/create")) {
          expect(url.searchParams.get("fromImage")).toBe(image);
          expect(url.searchParams.get("tag")).toBe(tag);
          return new Response('{"status":"Complete"}\n');
        }
        return new Response(null, { status: 204 });
      };
      await provider.provision(target, { ...request, image });
      expect(creates).toBe(2);
    }
  });

  test("does not pull on other create failures", async () => {
    for (const [status, message] of [
      [404, "No such network"],
      [500, "Engine unavailable"],
    ] as const) {
      calls = [];
      handler = () => Response.json({ message }, { status });
      await expect(provider.provision(target, request)).rejects.toThrow(message);
      expect(calls).toHaveLength(1);
    }
  });

  test("rejects an error within a successful HTTP pull response", async () => {
    handler = (url) =>
      url.pathname.endsWith("/images/create")
        ? new Response('{"status":"Pulling"}\n{"errorDetail":{"message":"pull denied"}}\n')
        : Response.json({ message: "No such image" }, { status: 404 });
    await expect(provider.provision(target, request)).rejects.toThrow("pull denied");
    expect(calls).toHaveLength(2);
  });

  test("lists only runtimes for this owner and sends both label filters", async () => {
    handler = (url) => {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "") as { label: string[] };
      return Response.json(
        [
          {
            Id: "ours",
            Created: 1791720000,
            Labels: {
              [RUNTIME_LABELS.runtimeId]: "runtime",
              [RUNTIME_LABELS.owner]: request.ownerId,
            },
          },
          {
            Id: "theirs",
            Labels: { [RUNTIME_LABELS.runtimeId]: "runtime", [RUNTIME_LABELS.owner]: "other" },
          },
          { Id: "legacy", Labels: { [RUNTIME_LABELS.runtimeId]: "runtime" } },
          { Id: "unrelated", Labels: { [RUNTIME_LABELS.owner]: request.ownerId } },
        ].filter((row) =>
          filters.label.every((label) => {
            const [key, value] = label.split("=");
            const labels: Record<string, string | undefined> = row.Labels;
            return (
              key !== undefined && (value === undefined ? key in labels : labels[key] === value)
            );
          }),
        ),
      );
    };
    const rows = await provider.list(target, request.ownerId);
    expect(rows.map((row) => row.externalId)).toEqual(["ours"]);
    expect(rows[0]?.createdAt).toBe("2026-10-11T12:00:00.000Z");
    expect(JSON.parse(calls[0]?.url.searchParams.get("filters") ?? "")).toEqual({
      label: [RUNTIME_LABELS.runtimeId, `${RUNTIME_LABELS.owner}=${request.ownerId}`],
    });
  });

  test("list reports the workspace key from the real mount, never from a label", async () => {
    handler = () =>
      Response.json([
        {
          Id: "mounted",
          Labels: { [RUNTIME_LABELS.runtimeId]: "a", workspaceKey: "swarm-ws-forged-0" },
          Mounts: [
            { Type: "volume", Name: "swarm-cache-pool", Destination: "/cache" },
            { Type: "volume", Name: "swarm-ws-agent-0", Destination: "/workspace/personal" },
          ],
        },
        {
          Id: "ephemeral",
          Labels: { [RUNTIME_LABELS.runtimeId]: "b", workspaceKey: "swarm-ws-agent-1" },
          Mounts: [{ Type: "bind", Source: "/tmp", Destination: "/workspace/personal" }],
        },
      ]);
    const rows = await provider.list(target, request.ownerId);
    expect(rows.map((row) => row.meta?.workspaceKey)).toEqual(["swarm-ws-agent-0", undefined]);
    expect(rows[0]?.meta?.[RUNTIME_LABELS.runtimeId]).toBe("a");
  });

  test("maps container states and distinguishes absence from lookup failure", async () => {
    for (const [status, exitCode, expected] of [
      ["created", 0, "starting"],
      ["running", 0, "running"],
      ["restarting", 0, "running"],
      ["exited", 0, "exited"],
      ["dead", 1, "failed"],
      ["exited", 2, "failed"],
      ["removing", 0, "unknown"],
    ] as const) {
      handler = () => Response.json({ State: { Status: status, ExitCode: exitCode } });
      expect(await provider.status(target, handle)).toBe(expected);
    }
    handler = () => new Response("missing", { status: 404 });
    expect(await provider.status(target, handle)).toBe("exited");
    handler = () => new Response("unavailable", { status: 500 });
    expect(await provider.status(target, handle)).toBe("unknown");
  });

  test("terminates through forced deletion", async () => {
    handler = () => new Response(null, { status: 204 });
    await provider.terminate(target, handle);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url.searchParams.get("force")).toBe("true");
    expect(calls[0]?.url.searchParams.get("v")).toBe("true");
  });

  test("termination succeeds when the container is already absent", async () => {
    handler = () => new Response("No such container", { status: 404 });
    await provider.terminate(target, handle);
    expect(calls).toHaveLength(1);
  });

  test("termination preserves other engine and transport errors", async () => {
    for (const status of [403, 500]) {
      handler = () => new Response("delete rejected", { status });
      await expect(provider.terminate(target, handle)).rejects.toThrow("delete rejected");
    }
    await expect(
      provider.terminate({ DOCKER_HOST: `unix://${socket}.missing` }, handle),
    ).rejects.toThrow("Set DOCKER_HOST");
  });

  test("scrubs sensitive environment values locally without registering ordinary values", async () => {
    const secret = `private-${crypto.randomUUID()}`;
    const agentId = crypto.randomUUID();
    const apiUrl = `https://${crypto.randomUUID()}.test`;
    const req = {
      ...request,
      env: { CUSTOM_PASSWORD: secret, AGENT_ID: agentId, MCP_BASE_URL: apiUrl },
    };
    handler = () =>
      new Response(`${"x".repeat(290)} bad env ${secret} ${agentId} ${apiUrl}`, { status: 500 });
    try {
      await provider.provision(target, req);
      throw new Error("Provision unexpectedly succeeded");
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).toContain("REDACTED");
      expect(String(err)).toContain(agentId);
      expect(String(err)).toContain(apiUrl);
    }
    expect(scrubSecrets(agentId)).toBe(agentId);
    expect(scrubSecrets(apiUrl)).toBe(apiUrl);
    expect(scrubSecrets(secret)).toBe(secret);
    handler = () => Response.json({ Id: handle.externalId });
    await provider.provision(target, req);
    expect(scrubSecrets(agentId)).toBe(agentId);
    expect(scrubSecrets(apiUrl)).toBe(apiUrl);
    expect(scrubSecrets(secret)).toBe(secret);
  });

  test("removes a created container after start failure and preserves that error", async () => {
    for (const cleanupStatus of [204, 500]) {
      calls = [];
      handler = (url, init) => {
        if (url.pathname.endsWith("/containers/create"))
          return Response.json({ Id: handle.externalId });
        if (init.method === "DELETE")
          return new Response(cleanupStatus === 204 ? null : "cleanup failed", {
            status: cleanupStatus,
          });
        return new Response("start failed", { status: 500 });
      };
      await expect(provider.provision(target, request)).rejects.toThrow("start failed");
      expect(calls.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual([
        "POST /v1.47/containers/create",
        "POST /v1.47/containers/container-1/start",
        "DELETE /v1.47/containers/container-1",
      ]);
      expect(calls[2]?.url.searchParams.get("force")).toBe("true");
      expect(calls[2]?.url.searchParams.get("v")).toBe("true");
    }
  });

  test("socket errors identify the attempted path and DOCKER_HOST configuration", async () => {
    const missingSocket = `${socket}.missing`;
    await expect(
      provider.list({ DOCKER_HOST: `unix://${missingSocket}` }, request.ownerId),
    ).rejects.toThrow(missingSocket);
    await expect(
      provider.list({ DOCKER_HOST: `unix://${missingSocket}` }, request.ownerId),
    ).rejects.toThrow("Set DOCKER_HOST");
    expect(calls).toHaveLength(0);
  });

  test("rejects TCP targets before any HTTP call", async () => {
    expect(provider.checkConfig({ DOCKER_HOST: "tcp://host:2375" }).ready).toBe(false);
    await expect(
      provider.list({ DOCKER_HOST: "tcp://host:2375" }, request.ownerId),
    ).rejects.toThrow("only supports unix sockets");
    expect(calls).toHaveLength(0);
  });
});
