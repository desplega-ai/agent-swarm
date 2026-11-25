import { expect, spyOn, test } from "bun:test";
import { apiMessage, failedJob, runnerMessage } from "../script-runner/protocol";
import { runWithCapacityRetry } from "../scripts-runtime/dispatch/capacity-retry";
import {
  dispatchScriptJob,
  setRemoteScriptRunnerPicker,
} from "../scripts-runtime/dispatch/dispatcher";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";

const job = () => ({
  id: crypto.randomUUID(),
  kind: "inline" as const,
  executor: "native" as const,
  input: {
    source: "export default () => 42",
    args: {},
    fsMode: "none" as const,
    network: "open" as const,
    resources: { ...DEFAULT_SCRIPT_RESOURCES },
    configPayload: {
      system: {
        apiKey: { value: "fixture", isSecret: true as const },
        agentId: { value: crypto.randomUUID(), isSecret: false as const },
        mcpBaseUrl: { value: "http://localhost", isSecret: false as const },
      },
      user: {},
    },
  },
});

test("protocol refuses malformed jobs, results and capacity declarations", () => {
  const fixture = job();
  const frame = { type: "job", jobId: fixture.id, ...fixture };
  expect(apiMessage.safeParse(frame).success).toBe(true);
  for (const resources of [
    { ...fixture.input.resources, wallClockMs: -1 },
    { ...fixture.input.resources, maxProcs: "unlimited" },
  ]) {
    expect(apiMessage.safeParse({ ...frame, input: { ...fixture.input, resources } }).success).toBe(
      false,
    );
  }
  expect(
    runnerMessage.safeParse({
      type: "hello",
      version: 1,
      instanceId: fixture.id,
      executors: ["native"],
      slots: 0,
      held: [],
    }).success,
  ).toBe(false);
  expect(
    runnerMessage.safeParse({ type: "result", jobId: fixture.id, output: { result: 42 } }).success,
  ).toBe(false);
});

test("capacity retries keep the selected executor and create fresh instances", async () => {
  const instances = new Set<NativeScriptExecutor>();
  const previous = process.env.SCRIPT_EXECUTOR;
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(async function (
    this: NativeScriptExecutor,
  ) {
    instances.add(this);
    process.env.SCRIPT_EXECUTOR = "quickjs";
    return { ...failedJob("executor_error"), error: "capacity_exceeded" };
  });
  try {
    expect((await runWithCapacityRetry(job())).error).toBe("capacity_exceeded");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(instances.size).toBe(3);
  } finally {
    spy.mockRestore();
    if (previous === undefined) delete process.env.SCRIPT_EXECUTOR;
    else process.env.SCRIPT_EXECUTOR = previous;
  }
});

test("capacity retry stops after cancellation", async () => {
  const abort = new AbortController();
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(async () => {
    abort.abort();
    return { ...failedJob("executor_error"), error: "capacity_exceeded" };
  });
  try {
    await runWithCapacityRetry(job(), abort.signal);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

test("remote dispatch refuses the operator key before transport", async () => {
  const previous = process.env.AGENT_SWARM_API_KEY;
  process.env.AGENT_SWARM_API_KEY = "fixture-operator-key";
  let sent = 0;
  setRemoteScriptRunnerPicker(() => ({
    id: "fixture",
    kind: "remote",
    async startHeld() {
      throw new Error("Fixture does not start held jobs");
    },
    async run() {
      sent++;
      return failedJob("executor_error");
    },
  }));
  try {
    const fixture = job();
    fixture.input.configPayload.system.apiKey.value = "fixture-operator-key";
    await expect(dispatchScriptJob(fixture)).rejects.toThrow("operator key");
    expect(sent).toBe(0);
  } finally {
    setRemoteScriptRunnerPicker(undefined);
    if (previous === undefined) delete process.env.AGENT_SWARM_API_KEY;
    else process.env.AGENT_SWARM_API_KEY = previous;
  }
});

test("a waiting native job leaves a compatible slot available for QuickJS", async () => {
  const previous = process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
  process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS = "0";
  const abort = new AbortController();
  const output = { ...failedJob("killed"), error: undefined, exitCode: 0, result: 42 };
  setRemoteScriptRunnerPicker((candidate) =>
    candidate.executor === "quickjs"
      ? { id: "fixture", kind: "remote", run: async () => output }
      : undefined,
  );
  try {
    const waiting = dispatchScriptJob(job(), { signal: abort.signal });
    expect((await dispatchScriptJob({ ...job(), executor: "quickjs" })).result).toBe(42);
    abort.abort();
    expect((await waiting).error).toBe("killed");
  } finally {
    abort.abort();
    setRemoteScriptRunnerPicker(undefined);
    if (previous === undefined) delete process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
    else process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS = previous;
  }
});

test("a nested sync call reaches its queue deadline when its parent holds the only slot", async () => {
  const slots = process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
  const wait = process.env.SCRIPT_QUEUE_WAIT_SYNC_MS;
  process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS = "0";
  process.env.SCRIPT_QUEUE_WAIT_SYNC_MS = "25";
  let busy = false;
  setRemoteScriptRunnerPicker(() =>
    busy
      ? undefined
      : {
          id: "fixture",
          kind: "remote",
          run: async () => {
            busy = true;
            try {
              return await dispatchScriptJob(job());
            } finally {
              busy = false;
            }
          },
        },
  );
  try {
    expect((await dispatchScriptJob(job())).error).toBe("capacity_exceeded");
  } finally {
    setRemoteScriptRunnerPicker(undefined);
    if (slots === undefined) delete process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
    else process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS = slots;
    if (wait === undefined) delete process.env.SCRIPT_QUEUE_WAIT_SYNC_MS;
    else process.env.SCRIPT_QUEUE_WAIT_SYNC_MS = wait;
  }
});

test("readiness requires a private directory and creates an atomic regular file", async () => {
  const { mkdtempSync, chmodSync, lstatSync, readFileSync, rmSync, symlinkSync, realpathSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runnerReadyFile } = await import("../script-runner/client");
  const directory = realpathSync(mkdtempSync(`${tmpdir()}/phase4-ready-`));
  const path = `${directory}/ready`;
  try {
    chmodSync(directory, 0o700);
    const ready = runnerReadyFile(path);
    ready.publish();
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("ready\n");
    ready.clear();
    symlinkSync(`${directory}/missing`, path);
    expect(() => runnerReadyFile(path)).toThrow("Invalid ready file");
    rmSync(path);
    chmodSync(directory, 0o755);
    expect(() => runnerReadyFile(path)).toThrow("private directory");
    runnerReadyFile().publish();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("outgoing frames enforce the byte limit before socket transmission", async () => {
  const { encodeRunnerFrame, MAX_FRAME_BYTES } = await import("../script-runner/protocol");
  expect(encodeRunnerFrame({ type: "cancel", jobId: "fixture" })).toContain("fixture");
  expect(() => encodeRunnerFrame({ value: "a".repeat(MAX_FRAME_BYTES) })).toThrow("byte limit");
});

test("runner retries service failure and transient close without policy refusal", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let attempts = 0;
  let refused = false;
  let welcome = false;
  server.on("upgrade", (req, socket, head) => {
    if (++attempts === 1) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once("message", () => {
        if (attempts === 2) ws.close(1011, "Temporary service failure");
        else {
          welcome = true;
          ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
        }
      });
    });
  });
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {
      refused = true;
    },
  });
  try {
    const end = Date.now() + 8000;
    while (!welcome && Date.now() < end) await Bun.sleep(20);
    expect(welcome).toBe(true);
    expect(refused).toBe(false);
    expect(attempts).toBe(3);
  } finally {
    await runner.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);

test("silent API connection loss aborts the runner job through its watchdog", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let aborted = false;
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(
    (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(failedJob("killed"));
          },
          { once: true },
        );
      }),
  );
  wss.on("connection", (ws) =>
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
      const fixture = job();
      ws.send(JSON.stringify({ type: "job", jobId: fixture.id, ...fixture }));
    }),
  );
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const end = Date.now() + 49000;
    while (!aborted && Date.now() < end) await Bun.sleep(50);
    expect(aborted).toBe(true);
  } finally {
    await runner.stop();
    spy.mockRestore();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 55000);

test("an oversized result fails its job and preserves the connection for another job", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const { MAX_FRAME_BYTES } = await import("../script-runner/protocol");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const outputs: Array<{ output: { error?: string; result?: number } }> = [];
  let runs = 0;
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(async () => ({
    ...failedJob("executor_error"),
    error: undefined,
    exitCode: 0,
    result: ++runs === 1 ? "a".repeat(MAX_FRAME_BYTES) : 42,
  }));
  wss.on("connection", (ws) => {
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
      const fixture = job();
      ws.send(JSON.stringify({ type: "job", jobId: fixture.id, ...fixture }));
      ws.on("message", (data) => {
        outputs.push(JSON.parse(data.toString()));
        if (outputs.length === 1) {
          const second = job();
          ws.send(JSON.stringify({ type: "job", jobId: second.id, ...second }));
        }
      });
    });
  });
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const end = Date.now() + 8000;
    while (outputs.length < 2 && Date.now() < end) await Bun.sleep(20);
    expect(outputs[0]?.output.error).toBe("executor_error");
    expect(outputs[1]?.output.result).toBe(42);
    expect(wss.clients.size).toBe(1);
  } finally {
    await runner.stop();
    spy.mockRestore();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);

test("durable results remain held until acknowledgement across reconnect", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const id = crypto.randomUUID();
  let connections = 0;
  let replayed = false;
  let heldAfterReconnect = false;
  wss.on("connection", (ws) => {
    const generation = ++connections;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        heldAfterReconnect ||= generation > 1 && message.held.includes(id);
        ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
        if (generation === 1)
          ws.send(
            JSON.stringify({
              type: "durable-job",
              jobId: id,
              run: {
                id,
                agentId: crypto.randomUUID(),
                kind: "workflow",
                status: "running",
                startedAt: new Date().toISOString(),
                source: `import { readdir, readFile } from "node:fs/promises";
                  export default async () => {
                    const files = await readdir(".");
                    const json = await Promise.all(files.filter(name => name.endsWith(".json")).map(name => readFile(name, "utf8")));
                    return {
                      value: 42,
                      credentialPresent: json.some(text => text.includes("fixture-runner-private")),
                      credentialEnv: Object.keys(process.env).filter(name => /^(API_KEY|AGENT_SWARM_API_KEY|SCRIPT_RUNNER_TOKEN|SCRIPT_RUNNER_TOKEN_FILE|DATABASE_URL)$/.test(name)),
                    };
                  }`,
                args: {},
              },
            }),
          );
      } else if (message.type === "heartbeat") {
        ws.send(
          JSON.stringify({
            type: "lease",
            nonce: message.nonce,
            jobs: message.jobs.map((jobId: string) => ({ jobId, leaseMs: 60000 })),
          }),
        );
      } else if (message.type === "durable-result") {
        expect(message.output.value).toBe(42);
        expect(message.output.credentialPresent).toBe(false);
        expect(message.output.credentialEnv).toEqual([]);
        if (generation === 1) ws.terminate();
        else {
          replayed = true;
          ws.send(JSON.stringify({ type: "ack", jobId: id }));
        }
      }
    });
  });
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture-runner-private",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const deadline = Date.now() + 10000;
    while (!replayed && Date.now() < deadline) await Bun.sleep(20);
    expect(replayed).toBe(true);
    expect(heldAfterReconnect).toBe(true);
  } finally {
    await runner.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);

test("capability replay does not consume admission and queued calls recheck ownership", async () => {
  const { createCapabilitySession, MAX_ACTIVE_CAPABILITY_DISPATCHES } = await import(
    "../script-workflows/capability-session"
  );
  const { SDK_ALLOWLIST } = await import("../scripts-runtime/sdk-allowlist");
  const method = SDK_ALLOWLIST[0]!;
  let authorized = true;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = {
    id: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    kind: "workflow" as const,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    source: "",
    args: {},
  };
  const session = createCapabilitySession(
    {
      run,
      baseUrl: "http://localhost",
      apiKey: "fixture",
      authorizeCapability: async () => authorized,
    },
    "fixture",
    true,
  );
  session.authenticate(JSON.stringify({ type: "hello", token: "fixture" }));
  session.built.ctx.swarm = {
    [method]: async () => {
      calls++;
      await gate;
      return 42;
    },
  };
  const replies: string[] = [];
  const send = async (frame: string) => {
    replies.push(frame);
  };
  const frame = (id: string) =>
    JSON.stringify({ type: "invoke", id, path: `swarm.${method}`, argsJson: "{}" });
  const requests = Array.from({ length: MAX_ACTIVE_CAPABILITY_DISPATCHES + 1 }, (_, id) =>
    session.receive(frame(String(id)), send),
  );
  for (let index = 0; index < 30 && calls < MAX_ACTIVE_CAPABILITY_DISPATCHES; index++)
    await Bun.sleep(1);
  expect(calls).toBe(MAX_ACTIVE_CAPABILITY_DISPATCHES);
  const duplicate = session.receive(frame("0"), send);
  authorized = false;
  release();
  try {
    await Promise.all([...requests, duplicate]);
    expect(calls).toBe(MAX_ACTIVE_CAPABILITY_DISPATCHES);
    expect(replies.some((reply) => reply.includes("ownership expired"))).toBe(true);
    session.confirmResponse("0");
    await session.receive(frame("0"), send);
    expect(replies.at(-1)).toContain("ownership expired");
  } finally {
    session.close();
  }
});

test("unconfirmed heartbeats do not extend a durable guest lease", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const { LocalProcessScriptExecutor } = await import("../script-workflows/executor");
  const original = LocalProcessScriptExecutor.prototype.start;
  let pid: number | null = null;
  const spy = spyOn(LocalProcessScriptExecutor.prototype, "start").mockImplementation(
    async function (input) {
      const handle = await original.call(this, input);
      pid = handle.pid;
      return handle;
    },
  );
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const id = crypto.randomUUID();
  let confirmed = false;
  let stopped = false;
  let draining = false;
  wss.on("connection", (ws) =>
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
        ws.send(
          JSON.stringify({
            type: "durable-job",
            jobId: id,
            run: {
              id,
              agentId: crypto.randomUUID(),
              kind: "workflow",
              status: "running",
              startedAt: new Date().toISOString(),
              source:
                "export default async () => { await new Promise(resolve => setTimeout(resolve, 60000)); return 42; }",
              args: {},
            },
          }),
        );
      } else if (message.type === "heartbeat" && !confirmed) {
        confirmed = true;
        ws.send(
          JSON.stringify({
            type: "lease",
            nonce: message.nonce,
            jobs: [{ jobId: id, leaseMs: 1000 }],
          }),
        );
      } else if (message.type === "durable-result") {
        stopped = message.terminated === true;
        ws.send(JSON.stringify({ type: "ack", jobId: id }));
      } else if (message.type === "draining") draining = true;
    }),
  );
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const deadline = Date.now() + 8000;
    while (!stopped && Date.now() < deadline) await Bun.sleep(20);
    expect(stopped).toBe(true);
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
    await runner.stop();
    await Bun.sleep(20);
    expect(draining).toBe(true);
  } finally {
    await runner.stop();
    spy.mockRestore();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);

test("runner owner identity binds the credential across API restart", async () => {
  const { scriptRunnerOwnerId } = await import("../be/script-runners/owner-identity");
  const instance = crypto.randomUUID();
  const credential = crypto.randomUUID();
  expect(scriptRunnerOwnerId(credential, instance)).toBe(scriptRunnerOwnerId(credential, instance));
  expect(scriptRunnerOwnerId(credential, instance)).not.toBe(
    scriptRunnerOwnerId(crypto.randomUUID(), instance),
  );
  expect(scriptRunnerOwnerId(credential, instance)).not.toBe(
    scriptRunnerOwnerId(credential, crypto.randomUUID()),
  );
});

test("step claims retain results across reconnect and ignore an early acknowledgement", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const fixture = job();
  const id = `${fixture.id}:${crypto.randomUUID()}`;
  let connections = 0;
  let replayed = false;
  let held = false;
  wss.on("connection", (ws) => {
    const generation = ++connections;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        held ||= generation > 1 && message.held.includes(id);
        expect(message.stepJobs).toBe(true);
        ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
        if (generation === 1) {
          ws.send(JSON.stringify({ type: "job", ...fixture, jobId: id, kind: "step-script" }));
          ws.send(JSON.stringify({ type: "ack", jobId: id }));
        }
      } else if (message.type === "heartbeat")
        ws.send(
          JSON.stringify({
            type: "lease",
            nonce: message.nonce,
            jobs: message.jobs.map((jobId: string) => ({ jobId, leaseMs: 60000 })),
          }),
        );
      else if (message.type === "result") {
        expect(message.output.result).toBe(42);
        if (generation === 1) ws.terminate();
        else {
          replayed = true;
          ws.send(JSON.stringify({ type: "ack", jobId: id }));
        }
      }
    });
  });
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const deadline = Date.now() + 10000;
    while (!replayed && Date.now() < deadline) await Bun.sleep(20);
    expect(replayed).toBe(true);
    expect(held).toBe(true);
  } finally {
    await runner.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);

test("step guests stop when confirmed lease time expires", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { listenOnFreePort } = await import("./test-net");
  const { startScriptRunner } = await import("../script-runner/client");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const fixture = job();
  fixture.input.source =
    "export default async () => {await new Promise(resolve=>setTimeout(resolve,60000));return 42;}";
  const id = `${fixture.id}:${crypto.randomUUID()}`;
  let expired = false;
  wss.on("connection", (ws) =>
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
        ws.send(JSON.stringify({ type: "job", ...fixture, jobId: id, kind: "step-script" }));
      } else if (message.type === "heartbeat")
        ws.send(
          JSON.stringify({
            type: "lease",
            nonce: message.nonce,
            jobs: [{ jobId: id, leaseMs: 200 }],
          }),
        );
      else if (message.type === "result") {
        expired = message.output.exitCode !== 0;
        ws.send(JSON.stringify({ type: "ack", jobId: id }));
      }
    }),
  );
  const port = await listenOnFreePort(server);
  const runner = startScriptRunner({
    apiUrl: `http://127.0.0.1:${port}`,
    token: "fixture",
    slots: 1,
    executors: ["native"],
    onRefused() {},
  });
  try {
    const deadline = Date.now() + 10000;
    while (!expired && Date.now() < deadline) await Bun.sleep(20);
    expect(expired).toBe(true);
  } finally {
    await runner.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  }
}, 15000);
