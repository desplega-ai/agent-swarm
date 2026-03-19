import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { closeDb, createWorkflow, getWorkflowRun, initDb, updateWorkflow } from "../be/db";
import type { Workflow } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { handleWebhookTrigger, verifyHmacSignature, WebhookError } from "../workflows/triggers";

const TEST_DB_PATH = "./test-workflow-triggers-v2.sqlite";

// ─── Test Executor ──────────────────────────────────────────

class NoopExecutor extends BaseExecutor<typeof NoopExecutor.schema, typeof NoopExecutor.outSchema> {
  static readonly schema = z.object({
    channel: z.string().optional(),
    template: z.string().optional(),
  });
  static readonly outSchema = z.object({ sent: z.boolean() });

  readonly type = "notify";
  readonly mode = "instant" as const;
  readonly configSchema = NoopExecutor.schema;
  readonly outputSchema = NoopExecutor.outSchema;

  protected async execute(): Promise<ExecutorResult<z.infer<typeof NoopExecutor.outSchema>>> {
    return { status: "success", output: { sent: true } };
  }
}

// ─── Setup ──────────────────────────────────────────────────

let registry: ExecutorRegistry;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  registry = new ExecutorRegistry();
  registry.register(new NoopExecutor());
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

// ─── Helpers ────────────────────────────────────────────────

function makeWorkflow(overrides?: Partial<Parameters<typeof createWorkflow>[0]>): Workflow {
  return createWorkflow({
    name: `test-wf-${crypto.randomUUID().slice(0, 8)}`,
    definition: {
      nodes: [
        {
          id: "n1",
          type: "notify",
          config: { channel: "swarm", template: "test" },
        },
      ],
    },
    ...overrides,
  });
}

// ─── HMAC Verification ──────────────────────────────────────

describe("verifyHmacSignature", () => {
  const secret = "test-secret-123";
  const body = '{"event":"test"}';

  test("valid sha256=<hex> signature passes", () => {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(body);
    const sig = `sha256=${hmac.digest("hex")}`;

    expect(verifyHmacSignature(secret, body, sig)).toBe(true);
  });

  test("valid raw hex signature passes", () => {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(body);
    const sig = hmac.digest("hex");

    expect(verifyHmacSignature(secret, body, sig)).toBe(true);
  });

  test("invalid signature fails", () => {
    expect(verifyHmacSignature(secret, body, "sha256=invalid")).toBe(false);
  });

  test("wrong secret fails", () => {
    const hmac = crypto.createHmac("sha256", "wrong-secret");
    hmac.update(body);
    const sig = `sha256=${hmac.digest("hex")}`;

    expect(verifyHmacSignature(secret, body, sig)).toBe(false);
  });

  test("empty signature fails", () => {
    expect(verifyHmacSignature(secret, body, "")).toBe(false);
  });
});

// ─── Webhook Trigger ────────────────────────────────────────

describe("handleWebhookTrigger", () => {
  test("valid HMAC starts workflow", async () => {
    const secret = "my-webhook-secret";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret }],
    });

    const body = '{"event":"deploy"}';
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(body);
    const sig = `sha256=${hmac.digest("hex")}`;

    const result = await handleWebhookTrigger(workflow.id, body, sig, sig, registry);

    expect(result.runId).toBeDefined();
    expect(typeof result.runId).toBe("string");

    // Verify the run was created
    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.workflowId).toBe(workflow.id);
  });

  test("invalid HMAC rejects with 401", async () => {
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: "secret-123" }],
    });

    try {
      await handleWebhookTrigger(
        workflow.id,
        '{"test":true}',
        "sha256=invalid",
        "sha256=invalid",
        registry,
      );
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  test("missing signature rejects with 401 when hmacSecret is set", async () => {
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: "secret-xyz" }],
    });

    try {
      await handleWebhookTrigger(workflow.id, '{"test":true}', undefined, undefined, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  test("no hmacSecret configured accepts any request", async () => {
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook" }],
    });

    const result = await handleWebhookTrigger(
      workflow.id,
      '{"data":"hello"}',
      undefined,
      undefined,
      registry,
    );

    expect(result.runId).toBeDefined();
    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
  });

  test("workflow not found returns 404", async () => {
    try {
      await handleWebhookTrigger(
        "00000000-0000-0000-0000-000000000000",
        "{}",
        undefined,
        undefined,
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(404);
    }
  });

  test("disabled workflow returns 400", async () => {
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook" }],
    });
    // Disable the workflow
    updateWorkflow(workflow.id, { enabled: false });

    try {
      await handleWebhookTrigger(workflow.id, "{}", undefined, undefined, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(400);
    }
  });
});

// ─── Manual Trigger ─────────────────────────────────────────

describe("manual trigger (startWorkflowExecution)", () => {
  test("always available — workflow starts without triggers", async () => {
    const workflow = makeWorkflow();

    const runId = await startWorkflowExecution(workflow, { manual: true }, registry);

    expect(runId).toBeDefined();
    const run = getWorkflowRun(runId);
    expect(run).not.toBeNull();
    // Should complete (single notify node)
    expect(run!.status).toBe("completed");
  });
});

// ─── Cooldown ───────────────────────────────────────────────

describe("cooldown", () => {
  test("trigger within cooldown window produces skipped run", async () => {
    const workflow = makeWorkflow({
      cooldown: { hours: 1 },
    });

    // First trigger — should complete normally
    const runId1 = await startWorkflowExecution(workflow, {}, registry);
    const run1 = getWorkflowRun(runId1);
    expect(run1!.status).toBe("completed");

    // Second trigger — should be skipped (within 1-hour cooldown)
    const runId2 = await startWorkflowExecution(workflow, {}, registry);
    const run2 = getWorkflowRun(runId2);
    expect(run2!.status).toBe("skipped");
    expect(run2!.error).toBe("cooldown");
  });

  test("no cooldown configured — always runs", async () => {
    const workflow = makeWorkflow();

    const runId1 = await startWorkflowExecution(workflow, {}, registry);
    const run1 = getWorkflowRun(runId1);
    expect(run1!.status).toBe("completed");

    const runId2 = await startWorkflowExecution(workflow, {}, registry);
    const run2 = getWorkflowRun(runId2);
    expect(run2!.status).toBe("completed");
  });
});
