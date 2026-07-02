const containerName = `agent-swarm-jaeger-${process.pid}`;
const jaegerQueryUrl = "http://127.0.0.1:16686";
const otlpEndpoint = "http://127.0.0.1:4318";

async function run(
  command: string,
  args: string[],
  options?: { env?: Record<string, string> },
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    env: options?.env ? { ...process.env, ...options.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

async function waitForJaeger(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${jaegerQueryUrl}/api/services`);
      if (response.ok) return;
    } catch {
      // Jaeger is still starting.
    }
    await Bun.sleep(500);
  }
  throw new Error("Jaeger query API did not become ready");
}

async function waitForOperations(service: string, expected: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${jaegerQueryUrl}/api/operations?service=${encodeURIComponent(service)}`,
    );
    if (response.ok) {
      const payload = (await response.json()) as { data?: Array<string | { name?: string }> };
      const operations = new Set(
        (payload.data ?? []).map((operation) =>
          typeof operation === "string" ? operation : operation.name,
        ),
      );
      if (expected.every((name) => operations.has(name))) return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`${service} did not receive expected operations: ${expected.join(", ")}`);
}

type JaegerSpan = {
  traceID: string;
  spanID: string;
  operationName: string;
  references?: Array<{ refType: string; traceID: string; spanID: string }>;
};

type JaegerTrace = {
  traceID: string;
  spans: JaegerSpan[];
};

async function fetchTraces(service: string, operation: string): Promise<JaegerTrace[]> {
  const response = await fetch(
    `${jaegerQueryUrl}/api/traces?service=${encodeURIComponent(service)}&operation=${encodeURIComponent(
      operation,
    )}&limit=20`,
  );
  if (!response.ok) {
    throw new Error(`Jaeger trace query failed for ${service}/${operation}: ${response.status}`);
  }
  const payload = (await response.json()) as { data?: JaegerTrace[] };
  return payload.data ?? [];
}

async function waitForTraceShape(
  service: string,
  operation: string,
  assertTrace: (trace: JaegerTrace) => string | null,
): Promise<JaegerTrace> {
  const deadline = Date.now() + 30_000;
  let lastFailure = "no traces returned";
  while (Date.now() < deadline) {
    const traces = await fetchTraces(service, operation);
    for (const trace of traces) {
      const failure = assertTrace(trace);
      if (!failure) return trace;
      lastFailure = failure;
    }
    await Bun.sleep(500);
  }
  throw new Error(`${service}/${operation} trace shape did not match: ${lastFailure}`);
}

function childOf(child: JaegerSpan | undefined, parent: JaegerSpan | undefined): boolean {
  if (!child || !parent) return false;
  return Boolean(
    child.references?.some(
      (ref) =>
        ref.refType === "CHILD_OF" &&
        ref.traceID === parent.traceID &&
        ref.spanID === parent.spanID,
    ),
  );
}

async function emitApiSpan(): Promise<void> {
  await run(
    "bun",
    [
      "-e",
      `
      const otel = await import("./apps/swarm/src/otel.ts");
      await otel.initOtel("api");
      await otel.withSpan("http.server", async (span) => {
        span.setAttributes({
          "http.request.method": "GET",
          "url.path": "/health",
          "http.response.status_code": 200,
          "agentswarm.component": "api"
        });
        await otel.withSpan("mcp.tool", async (toolSpan) => {
          toolSpan.setAttributes({
            "mcp.tool.name": "store-progress",
            "mcp.session.id": "otel-e2e-mcp-session",
            "agent.id": "otel-e2e-agent",
            "agentswarm.task.id": "otel-e2e-task",
            "mcp.tool.result_content_count": 1,
            "mcp.tool.is_error": false
          });
        });
      });
      await otel.shutdownOtel();
      `,
    ],
    {
      env: {
        AGENT_ROLE: "api",
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
    },
  );
}

async function emitWorkerSpans(): Promise<void> {
  await run(
    "bun",
    [
      "-e",
      `
      const otel = await import("./apps/swarm/src/otel.ts");
      await otel.initOtel("lead");
      await otel.withSpan("worker.poll", async (span) => {
        span.setAttribute("agentswarm.poll.result", "demo");
      }, { "agent.id": "otel-e2e-agent" });
      await otel.withSpan("worker.session.create", async (span) => {
        span.setAttributes({
          "agent.id": "otel-e2e-agent",
          "agentswarm.task.id": "otel-e2e-task",
          "agentswarm.harness_provider": "codex",
          "agentswarm.provider.session_id": "otel-e2e-provider-session",
          "gen_ai.request.model": "test-model"
        });
      });
      const sessionSpan = otel.startSpan("worker.session", {
        "agent.id": "otel-e2e-agent",
        "agentswarm.task.id": "otel-e2e-task",
        "agentswarm.harness_provider": "codex",
        "agentswarm.provider.session_id": "otel-e2e-provider-session",
        "agentswarm.session.exit_code": 0,
        "agentswarm.session.outcome": "ok"
      });
      await otel.withSpanContext(sessionSpan, async () => {
        const mcpToolSpan = otel.startSpan("worker.mcp.tool", {
          "agent.id": "otel-e2e-agent",
          "agentswarm.task.id": "otel-e2e-task",
          "agentswarm.harness_provider": "codex",
          "agentswarm.provider.session_id": "otel-e2e-provider-session",
          "agentswarm.tool.name": "mcp__agent_swarm__store_progress",
          "agentswarm.tool.normalized_name": "agent_swarm.store_progress",
          "agentswarm.tool.kind": "mcp",
          "mcp.server.name": "agent_swarm",
          "mcp.tool.name": "store_progress"
        });
        mcpToolSpan.end();
        const shellToolSpan = otel.startSpan("worker.tool", {
          "agent.id": "otel-e2e-agent",
          "agentswarm.task.id": "otel-e2e-task",
          "agentswarm.harness_provider": "codex",
          "agentswarm.provider.session_id": "otel-e2e-provider-session",
          "agentswarm.tool.name": "shell",
          "agentswarm.tool.normalized_name": "shell",
          "agentswarm.tool.kind": "tool"
        });
        shellToolSpan.end();
      });
      sessionSpan.end();
      await otel.shutdownOtel();
      `,
    ],
    {
      env: {
        AGENT_ID: "otel-e2e-agent",
        AGENT_ROLE: "lead",
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
    },
  );
}

async function main() {
  await run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    "COLLECTOR_OTLP_ENABLED=true",
    "-p",
    "16686:16686",
    "-p",
    "4318:4318",
    "jaegertracing/all-in-one:1.57",
  ]);

  try {
    await waitForJaeger();
    await emitApiSpan();
    await emitWorkerSpans();
    await waitForOperations("agent-swarm-api", ["http.server", "mcp.tool"]);
    await waitForOperations("agent-swarm-worker", [
      "worker.poll",
      "worker.session.create",
      "worker.session",
      "worker.mcp.tool",
      "worker.tool",
    ]);
    const apiTrace = await waitForTraceShape("agent-swarm-api", "http.server", (trace) => {
      const httpServer = trace.spans.find((span) => span.operationName === "http.server");
      const mcpTool = trace.spans.find((span) => span.operationName === "mcp.tool");
      if (!httpServer) return "missing http.server span";
      if (!mcpTool) return "missing mcp.tool span";
      if (!childOf(mcpTool, httpServer)) return "mcp.tool is not a child of http.server";
      return null;
    });
    const workerTrace = await waitForTraceShape("agent-swarm-worker", "worker.session", (trace) => {
      const session = trace.spans.find((span) => span.operationName === "worker.session");
      const sessionCreate = trace.spans.find(
        (span) => span.operationName === "worker.session.create",
      );
      const mcpTool = trace.spans.find((span) => span.operationName === "worker.mcp.tool");
      const shellTool = trace.spans.find((span) => span.operationName === "worker.tool");
      if (!session) return "missing worker.session span";
      if (!mcpTool) return "missing worker.mcp.tool span";
      if (!shellTool) return "missing worker.tool span";
      if (!childOf(mcpTool, session)) return "worker.mcp.tool is not a child of worker.session";
      if (!childOf(shellTool, session)) return "worker.tool is not a child of worker.session";
      if (sessionCreate && childOf(mcpTool, sessionCreate)) {
        return "worker.mcp.tool is still nested under worker.session.create";
      }
      return null;
    });
    console.log(
      [
        "Jaeger received OpenTelemetry spans with expected nesting:",
        `api trace ${apiTrace.traceID}: mcp.tool -> http.server`,
        `worker trace ${workerTrace.traceID}: worker.mcp.tool + worker.tool -> worker.session`,
      ].join("\n"),
    );
  } finally {
    await run("docker", ["rm", "-f", containerName]).catch(() => "");
  }
}

await main();
