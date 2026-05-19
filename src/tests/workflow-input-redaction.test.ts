import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getWorkflowRunStepsByRunId,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import {
  getSecretInputKeys,
  REDACTED_SECRET_VALUE,
  redactSecretsForStorage,
  resolveInputs,
} from "../workflows/input";

const TEST_DB_PATH = "./test-workflow-input-redaction.sqlite";

// Captures the input it was invoked with so we can assert what the executor
// actually receives (real value, not redacted).
class CaptureExecutor extends BaseExecutor<
  typeof CaptureExecutor.schema,
  typeof CaptureExecutor.outSchema
> {
  static readonly schema = z.object({ tokenSeen: z.string().optional() });
  static readonly outSchema = z.object({ ok: z.boolean() });

  readonly type = "capture";
  readonly mode = "instant" as const;
  readonly configSchema = CaptureExecutor.schema;
  readonly outputSchema = CaptureExecutor.outSchema;

  static lastTokenSeen: string | undefined = undefined;

  protected async execute(
    config: z.infer<typeof CaptureExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof CaptureExecutor.outSchema>>> {
    CaptureExecutor.lastTokenSeen = config.tokenSeen;
    return { status: "success", output: { ok: true } };
  }
}

describe("getSecretInputKeys", () => {
  test("flags secret.* references", () => {
    const keys = getSecretInputKeys({ GITHUB_TOKEN: "secret.GITHUB_TOKEN" });
    expect(keys.has("GITHUB_TOKEN")).toBe(true);
    expect(keys.size).toBe(1);
  });

  test("flags sensitive env-var references", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
    const keys = getSecretInputKeys({ GH: "${GITHUB_TOKEN}" });
    expect(keys.has("GH")).toBe(true);
  });

  test("does not flag non-sensitive env-var references", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
    const keys = getSecretInputKeys({ branch: "${GIT_BRANCH}", url: "${MCP_BASE_URL}" });
    expect(keys.size).toBe(0);
  });

  test("does not flag literal strings", () => {
    const keys = getSecretInputKeys({ name: "literal", count: "42" });
    expect(keys.size).toBe(0);
  });

  test("handles undefined input", () => {
    const keys = getSecretInputKeys(undefined);
    expect(keys.size).toBe(0);
  });

  test("flags all sensitive-suffix env names", () => {
    const keys = getSecretInputKeys({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
      a: "${FOO_TOKEN}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
      b: "${BAR_API_KEY}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
      c: "${BAZ_SECRET}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
      d: "${QUX_PASSWORD}",
    });
    expect(keys.size).toBe(4);
  });
});

describe("redactSecretsForStorage", () => {
  test("returns ctx unchanged when no secret keys", () => {
    const ctx = { input: { foo: "bar" } };
    const out = redactSecretsForStorage(ctx, new Set());
    expect(out).toBe(ctx);
  });

  test("redacts only declared secret keys in ctx.input", () => {
    const ctx = {
      trigger: { topic: "tuxedo" },
      input: { GITHUB_TOKEN: "ghp_real_value_xxx", branch: "main" },
    };
    const out = redactSecretsForStorage(ctx, new Set(["GITHUB_TOKEN"]));
    expect((out.input as Record<string, unknown>).GITHUB_TOKEN).toBe(REDACTED_SECRET_VALUE);
    expect((out.input as Record<string, unknown>).branch).toBe("main");
    // Trigger block untouched
    expect(out.trigger).toEqual({ topic: "tuxedo" });
  });

  test("does not mutate the original ctx (executor still sees real value)", () => {
    const ctx = { input: { GITHUB_TOKEN: "ghp_real" } };
    redactSecretsForStorage(ctx, new Set(["GITHUB_TOKEN"]));
    expect((ctx.input as Record<string, unknown>).GITHUB_TOKEN).toBe("ghp_real");
  });

  test("no-ops when ctx has no input block", () => {
    const ctx = { trigger: {} };
    const out = redactSecretsForStorage(ctx, new Set(["GITHUB_TOKEN"]));
    expect(out).toBe(ctx);
  });

  test("no-ops when secret key isn't actually present in ctx.input", () => {
    const ctx = { input: { unrelated: "x" } };
    const out = redactSecretsForStorage(ctx, new Set(["GITHUB_TOKEN"]));
    expect(out).toBe(ctx);
  });
});

describe("end-to-end — workflow step persistence redacts secrets", () => {
  beforeAll(() => {
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // ignore
    }
  });

  let workflowId: string | null = null;

  beforeEach(() => {
    CaptureExecutor.lastTokenSeen = undefined;
  });

  afterEach(() => {
    if (workflowId) {
      try {
        deleteWorkflow(workflowId);
      } catch {
        // ignore
      }
      workflowId = null;
    }
  });

  test("ctx.input[secretKey] is redacted in workflow_run_steps but real value reaches the executor", async () => {
    // Seed swarm config with a "secret" value
    const SECRET_VALUE = "ghp_supersecret_token_value_abc123";
    upsertSwarmConfig({
      scope: "global",
      key: "TEST_REDACTION_GITHUB_TOKEN",
      value: SECRET_VALUE,
      isSecret: true,
    });

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "capture-node",
          type: "capture",
          config: { tokenSeen: "{{input.GITHUB_TOKEN}}" },
        },
      ],
    };
    const workflow = createWorkflow({
      name: `redaction-test-${Date.now()}`,
      definition: def,
      triggers: [],
      input: {
        GITHUB_TOKEN: "secret.TEST_REDACTION_GITHUB_TOKEN",
        plain: "not-a-secret",
      },
    });
    workflowId = workflow.id;

    const registry = new ExecutorRegistry();
    const deps: ExecutorDependencies = {
      db: {} as typeof import("../be/db"),
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (t: string) => t,
    };
    registry.register(new CaptureExecutor(deps));

    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect(runId).toBeDefined();

    // Executor must see the REAL secret value (interpolated from live ctx)
    expect(CaptureExecutor.lastTokenSeen).toBe(SECRET_VALUE);

    // Persisted step.input must have the secret redacted
    const steps = getWorkflowRunStepsByRunId(runId);
    expect(steps.length).toBe(1);
    const persistedInput = steps[0]!.input as Record<string, unknown>;
    const persistedInputBlock = persistedInput.input as Record<string, unknown>;
    expect(persistedInputBlock.GITHUB_TOKEN).toBe(REDACTED_SECRET_VALUE);
    // Non-secret key untouched
    expect(persistedInputBlock.plain).toBe("not-a-secret");
    // The real secret string must NOT appear anywhere in the persisted JSON
    const serialized = JSON.stringify(steps[0]);
    expect(serialized.includes(SECRET_VALUE)).toBe(false);
  });
});

describe("resolveInputs (unchanged behavior)", () => {
  test("still resolves env-var references", () => {
    process.env.TEST_REDACT_VAR = "resolved";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env-var syntax
    const out = resolveInputs({ x: "${TEST_REDACT_VAR}" });
    expect(out.x).toBe("resolved");
    delete process.env.TEST_REDACT_VAR;
  });
});
