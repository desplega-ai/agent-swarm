import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntimeProvider } from "../runtime-providers/docker";
import { type ProvisionRequest, RUNTIME_LABELS } from "../runtime-providers/types";
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
