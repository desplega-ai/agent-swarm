import { workerCommand } from "../harness";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { MockRequest } from "../mocks/llm";
import type { Scenario } from "../run";
import { minimalEnv, repoRoot, tailLog } from "../sut";

/** The body of the `task.nudge.structured_output_missing` template. */
const NUDGE = "Your last message was not valid JSON for the required schema.";

const TASK_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, note: { type: "string" } },
  required: ["answer"],
};
/** What Codex must send: every object closed, the optional `note` required but nullable. */
const STRICT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["answer", "note"],
  additionalProperties: false,
};

/**
 * The schema as JSON with object keys and `required` sorted. Postgres JSONB stores
 * outputSchema keys shortest-first, and key order means nothing to a JSON schema.
 */
function canonical(value: unknown): string {
  const sort = (node: unknown, key?: string): unknown => {
    if (Array.isArray(node)) {
      const items = node.map((item) => sort(item));
      return key === "required" ? [...items].sort() : items;
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((k) => [k, sort((node as Record<string, unknown>)[k], k)]),
      );
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

function inputText(request: MockRequest): string {
  return JSON.stringify(asRecord(request.body).input ?? "");
}

/** The request's `text.format` (where the Responses API carries a JSON schema), if any. */
function formatOf(request: MockRequest): Record<string, unknown> {
  return (request.body as { text?: { format?: Record<string, unknown> } }).text?.format ?? {};
}

/**
 * A real codex worker (`agent-swarm worker`, HARNESS_PROVIDER=codex, the codex app-server
 * from node_modules) runs against the mock's Responses API through the gateway route.
 * A task's outputSchema reaches the request in strict mode; a turn that ends in prose gets
 * exactly one reprompt, which completes the task when it answers JSON and fails it when it
 * misses again; a task without a schema sends none and gets no reprompt.
 */
export const codexStructuredOutput: Scenario = {
  name: "codex-structured-output",
  order: 275,
  async run(ctx) {
    const marker = (name: string) => `CSO-${name}-${ctx.nonce}`;
    const fixed = marker("fixed");
    const missed = marker("missed");
    const plain = marker("plain");
    // Only Codex traffic uses this path, so the SUT's own inference calls stay out of the counts.
    const codexPath = "/codex/v1/responses";
    const turns = (name: string) =>
      ctx.llm.requests.filter(
        (request) => request.path === codexPath && inputText(request).includes(name),
      );
    ctx.llm.setChatResponder((request) => {
      const input = JSON.stringify(request.input ?? "");
      if (input.includes(fixed) && input.includes(NUDGE)) return { answer: "fixed", note: null };
      if (input.includes(fixed) || input.includes(missed)) return "The answer is fixed.";
      if (input.includes(plain)) return `plain done ${plain}`;
      return undefined;
    });

    const register = await ctx.api("POST", "/api/agents", {
      body: {
        name: `e2e-codex-structured-${ctx.nonce}`,
        role: "worker",
        status: "online",
        harness_provider: "codex",
      },
    });
    expectStatus(register, [201], "register the codex worker");
    const agentId = String(asRecord(register.json).id);

    const homeDir = `/tmp/e2e-codex-structured-${ctx.nonce}`;
    const workspaceDir = `${homeDir}/workspace`;
    await Bun.$`mkdir -p ${homeDir}/logs ${workspaceDir}`.quiet();
    if (process.getuid?.() === 0 && Bun.which("gosu")) {
      await Bun.$`chown -R worker:worker ${homeDir}`.quiet();
    }
    const logPath = `${homeDir}/worker.log`;
    const writer = Bun.file(logPath).writer();
    const child = Bun.spawn(workerCommand(homeDir), {
      cwd: repoRoot,
      env: {
        ...minimalEnv(),
        HOME: homeDir,
        LOG_DIR: `${homeDir}/logs`,
        AGENT_ID: agentId,
        MCP_BASE_URL: ctx.baseUrl,
        API_KEY: ctx.apiKey,
        AGENT_SWARM_API_KEY: ctx.apiKey,
        HARNESS_PROVIDER: "codex",
        AGENT_ROLE: "worker",
        MAX_CONCURRENT_TASKS: "1",
        SLACK_DISABLE: "true",
        GITHUB_DISABLE: "true",
        DISABLE_AUTOUPDATER: "1",
        STARTUP_SCRIPT_STRICT: "false",
        CODEX_GATEWAY_BASE_URL: `${ctx.llm.origin}/codex/v1`,
        CODEX_GATEWAY_API_KEY: ctx.llm.apiKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const drains = Promise.all(
      [child.stdout, child.stderr].map(async (stream) => {
        for await (const chunk of stream) writer.write(chunk);
      }),
    );

    // One task at a time: the worker takes one, and each case reads only its own turns.
    const runTask = async (name: string, outputSchema?: Record<string, unknown>) => {
      const create = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `Structured output check ${name}. Answer in one short message. Do not use any tools.`,
          routingReason: "human_pinned",
          agentId,
          source: "api",
          dir: workspaceDir,
          ...(outputSchema ? { outputSchema } : {}),
        },
      });
      expectStatus(create, [201], `create task ${name}`);
      const taskId = String(asRecord(create.json).id);
      let task: Record<string, unknown> = {};
      const done = await pollUntil(
        async () => {
          const response = await ctx.api("GET", `/api/tasks/${taskId}`);
          task = asRecord(response.json);
          return task.status === "completed" || task.status === "failed";
        },
        180_000,
        1_000,
      );
      expect(done, `task ${name} did not finish within 180s (status ${String(task.status)})`);
      return task;
    };

    try {
      // 1 + 2: the strict rewrite reaches the request, a prose turn gets one reprompt and
      // the JSON answer to it completes the task.
      const fixedTask = await runTask(fixed, TASK_SCHEMA);
      const fixedTurns = turns(fixed);
      expect(
        fixedTurns.length === 2,
        `schema task made ${fixedTurns.length} model requests, expected the turn plus one reprompt`,
      );
      for (const turn of fixedTurns) {
        const format = formatOf(turn);
        expect(
          format.type === "json_schema" && format.strict === true,
          `codex request text.format is not strict json_schema: ${JSON.stringify(format)}`,
        );
        expect(
          canonical(format.schema) === canonical(STRICT_SCHEMA),
          `codex sent ${JSON.stringify(format.schema)}, expected the strict rewrite ${JSON.stringify(STRICT_SCHEMA)}`,
        );
      }
      expect(
        !inputText(fixedTurns[0]!).includes(NUDGE) && inputText(fixedTurns[1]!).includes(NUDGE),
        "the second schema-task request is not the structured-output reprompt",
      );
      expect(
        fixedTask.status === "completed",
        `reprompted task ended ${String(fixedTask.status)}: ${String(fixedTask.failureReason)}`,
      );
      const output = JSON.parse(String(fixedTask.output)) as Record<string, unknown>;
      expect(
        output.answer === "fixed" && !("note" in output),
        `reprompted task output ${String(fixedTask.output)}, expected {"answer":"fixed"}`,
      );

      // 3: a second miss stops after the one reprompt and fails the task.
      const missedTask = await runTask(missed, TASK_SCHEMA);
      const missedTurns = turns(missed);
      expect(
        missedTurns.length === 2,
        `missed task made ${missedTurns.length} model requests, expected the turn plus one reprompt`,
      );
      expect(
        missedTask.status === "failed" && String(missedTask.failureReason).includes("outputSchema"),
        `missed task ended ${String(missedTask.status)}: ${String(missedTask.failureReason)}`,
      );

      // 4: no outputSchema, no schema on the wire and no reprompt.
      const plainTask = await runTask(plain);
      const plainTurns = turns(plain);
      expect(
        plainTurns.length === 1,
        `plain task made ${plainTurns.length} model requests, expected 1`,
      );
      const plainFormat = formatOf(plainTurns[0]!);
      expect(
        plainFormat.type !== "json_schema" && !inputText(plainTurns[0]!).includes(NUDGE),
        `plain task sent a schema or a reprompt: ${JSON.stringify(plainFormat)}`,
      );
      expect(
        plainTask.status === "completed" && String(plainTask.output).includes(plain),
        `plain task ended ${String(plainTask.status)}: ${String(plainTask.output ?? plainTask.failureReason)}`,
      );
    } catch (error) {
      writer.flush();
      ctx.log(`Last 60 lines of the codex worker log:\n${await tailLog(logPath, 60)}`);
      throw error;
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(10_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await drains.catch(() => {});
      writer.end();
      await Bun.$`rm -rf ${homeDir}`.quiet().catch(() => {});
    }
  },
};
