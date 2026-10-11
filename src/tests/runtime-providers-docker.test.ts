import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerRuntimeProvider } from "../runtime-providers/docker";
import { type ProvisionRequest, RUNTIME_LABELS } from "../runtime-providers/types";

const provider = new DockerRuntimeProvider();
const target = { DOCKER_HOST: "unix:///tmp/runtime-provider-test.sock" };
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
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  calls = [];
  handler = () => Response.json({ Id: handle.externalId });
  // Mock HTTP because the sandbox cannot access a real Docker socket.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    mock(async (input, init) => {
      const url = new URL(String(input));
      const options = init ?? {};
      expect((options as RequestInit & { unix: string }).unix).toBe(
        "/tmp/runtime-provider-test.sock",
      );
      calls.push({ url, init: options });
      return handler(url, options);
    }),
  );
});

afterEach(() => fetchSpy.mockRestore());

describe("Docker runtime provider", () => {
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
      "POST /v1.43/containers/create",
      "POST /v1.43/containers/container-1/start",
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
    handler = () =>
      Response.json([
        {
          Id: "ours",
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
      ]);
    const rows = await provider.list(target, request.ownerId);
    expect(rows.map((row) => row.externalId)).toEqual(["ours"]);
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

  test("scrubs environment values echoed by Docker and transport failures", async () => {
    const secret = `private-${crypto.randomUUID()}`;
    const req = { ...request, env: { CUSTOM_PASSWORD: secret } };
    handler = () => new Response(`bad env ${secret}`, { status: 500 });
    try {
      await provider.provision(target, req);
      throw new Error("Provision unexpectedly succeeded");
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).toContain("REDACTED");
    }
    handler = () => {
      throw new Error(`transport ${secret}`);
    };
    await expect(provider.list(target, request.ownerId)).rejects.toThrow("REDACTED");
  });

  test("rejects TCP targets before any HTTP call", async () => {
    expect(provider.checkConfig({ DOCKER_HOST: "tcp://host:2375" }).ready).toBe(false);
    await expect(
      provider.list({ DOCKER_HOST: "tcp://host:2375" }, request.ownerId),
    ).rejects.toThrow("only supports unix sockets");
    expect(calls).toHaveLength(0);
  });
});
