import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  getWorkflowRun,
  initDb,
  updateWorkflow,
  upsertSwarmConfig,
} from "../be/db";
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

    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-hub-signature-256": sig },
      registry,
    );

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
        { "x-hub-signature-256": "sha256=invalid" },
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
      await handleWebhookTrigger(workflow.id, '{"test":true}', {}, registry);
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

    const result = await handleWebhookTrigger(workflow.id, '{"data":"hello"}', {}, registry);

    expect(result.runId).toBeDefined();
    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
  });

  test("workflow not found returns 404", async () => {
    try {
      await handleWebhookTrigger("00000000-0000-0000-0000-000000000000", "{}", {}, registry);
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
      await handleWebhookTrigger(workflow.id, "{}", {}, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(400);
    }
  });
});

// ─── Custom HMAC header + secret refs ───────────────────────

describe("handleWebhookTrigger — custom hmacHeader", () => {
  function signRaw(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("custom hmacHeader (X-Webhook-Signature) is picked up and verified", async () => {
    const secret = "kapso-secret";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret, hmacHeader: "X-Webhook-Signature" }],
    });

    const body = '{"event":"message"}';
    // Kapso-style: raw hex, no `sha256=` prefix.
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-webhook-signature": signRaw(secret, body) },
      registry,
    );

    expect(result.runId).toBeDefined();
    expect(getWorkflowRun(result.runId)).not.toBeNull();
  });

  test("custom hmacHeader lookup is case-insensitive", async () => {
    const secret = "kapso-secret-ci";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret, hmacHeader: "X-Webhook-Signature" }],
    });

    const body = '{"event":"ci"}';
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "X-Webhook-Signature": signRaw(secret, body) },
      registry,
    );

    expect(result.runId).toBeDefined();
  });

  test("signature on a non-configured header is rejected as missing", async () => {
    const secret = "kapso-secret-2";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret, hmacHeader: "X-Webhook-Signature" }],
    });

    const body = '{"event":"x"}';
    // Use a header that is neither the configured one nor a known fallback.
    try {
      await handleWebhookTrigger(
        workflow.id,
        body,
        { "x-some-other-header": signRaw(secret, body) },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  test("fallback header (x-signature) still works without explicit hmacHeader", async () => {
    const secret = "fallback-secret";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret }],
    });

    const body = '{"event":"fallback"}';
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-signature": signRaw(secret, body) },
      registry,
    );

    expect(result.runId).toBeDefined();
  });

  test("default X-Hub-Signature-256 path still works (no regression)", async () => {
    const secret = "default-header-secret";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret }],
    });

    const body = '{"event":"default"}';
    const sig = `sha256=${signRaw(secret, body)}`;
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-hub-signature-256": sig },
      registry,
    );

    expect(result.runId).toBeDefined();
  });
});

describe("handleWebhookTrigger — hmacSecret references", () => {
  function signRaw(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("hmacSecret as secret.NAME ref resolves and verifies", async () => {
    const SECRET_VALUE = "resolved-kapso-hmac-value";
    upsertSwarmConfig({
      scope: "global",
      key: "TEST_KAPSO_WEBHOOK_HMAC_SECRET",
      value: SECRET_VALUE,
      isSecret: true,
    });

    const workflow = makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: "secret.TEST_KAPSO_WEBHOOK_HMAC_SECRET",
          hmacHeader: "X-Webhook-Signature",
        },
      ],
    });

    const body = '{"event":"secret-ref"}';
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-webhook-signature": signRaw(SECRET_VALUE, body) },
      registry,
    );

    expect(result.runId).toBeDefined();
    expect(getWorkflowRun(result.runId)).not.toBeNull();
  });

  test("unresolvable secret.NAME ref fails cleanly with a WebhookError", async () => {
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: "secret.NONEXISTENT_HMAC_SECRET_12345" }],
    });

    const body = '{"event":"missing-secret"}';
    try {
      await handleWebhookTrigger(
        workflow.id,
        body,
        { "x-hub-signature-256": "deadbeef" },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(500);
    }
  });

  test("a literal hmacSecret is not treated as a reference", async () => {
    const secret = "plain.literal-not-a-ref";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret }],
    });

    const body = '{"event":"literal"}';
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-hub-signature-256": signRaw(secret, body) },
      registry,
    );

    expect(result.runId).toBeDefined();
  });
});

// ─── Trigger payload JSON parsing ───────────────────────────

describe("handleWebhookTrigger — triggerData JSON parsing", () => {
  function signRaw(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("JSON body is parsed and run.triggerData is a deep-equal object", async () => {
    const workflow = makeWorkflow({ triggers: [{ type: "webhook" }] });
    const payload = {
      message: { from: "+34000111222", text: "hi" },
      conversation: { id: "conv-abc-123" },
    };
    const body = JSON.stringify(payload);

    const result = await handleWebhookTrigger(workflow.id, body, {}, registry);

    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toEqual(payload);
    // Deep paths must be reachable (this is what `{{trigger.message.from}}` needs).
    expect((run!.triggerData as { message: { from: string } }).message.from).toBe("+34000111222");
  });

  test("signed JSON body: HMAC verified against raw bytes, triggerData parsed to object", async () => {
    const secret = "kapso-deep-secret";
    const workflow = makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secret, hmacHeader: "X-Webhook-Signature" }],
    });
    // Use whitespace + unsorted keys so any re-serialization would change the bytes.
    const body = '{ "message": {"from":"+1","text":"hi"},  "id":"x" }';
    const sig = signRaw(secret, body);

    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      { "x-webhook-signature": sig },
      registry,
    );

    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toEqual({ message: { from: "+1", text: "hi" }, id: "x" });
  });

  test("non-JSON body falls back to the raw string and does not throw", async () => {
    const workflow = makeWorkflow({ triggers: [{ type: "webhook" }] });
    const body = "this is not json at all";

    const result = await handleWebhookTrigger(workflow.id, body, {}, registry);

    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toBe(body);
  });

  test("empty body produces a run without throwing", async () => {
    const workflow = makeWorkflow({ triggers: [{ type: "webhook" }] });

    const result = await handleWebhookTrigger(workflow.id, "", {}, registry);

    expect(result.runId).toBeDefined();
    const run = getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
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
