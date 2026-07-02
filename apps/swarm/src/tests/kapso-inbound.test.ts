import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeDb, createAgent, createUser, getKv, getTaskById, initDb } from "../be/db";
import { findUserByExternalId, linkIdentity } from "../be/users";
import { handleWebhooks } from "../http/webhooks";
import { putKapsoNumberMapping } from "../integrations/kapso/config";
import { routeKapsoInbound } from "../integrations/kapso/inbound";

const TEST_DB_PATH = "./test-kapso-inbound.sqlite";
const HMAC_SECRET = "kapso-test-hmac-secret";

let agentId: string;
const originalFetch = globalThis.fetch;

function makePayload(opts: {
  phoneNumberId: string;
  messageId?: string;
  direction?: string;
  type?: string;
  text?: string;
  from?: string;
  conversationId?: string;
}) {
  return {
    message: {
      id: opts.messageId ?? `wamid.${Math.random().toString(36).slice(2)}`,
      from: opts.from ?? "34679077777",
      type: opts.type ?? "text",
      text: { body: opts.text ?? "hola" },
      kapso: { direction: opts.direction ?? "inbound", content: opts.text ?? "hola" },
    },
    conversation: {
      id: opts.conversationId ?? "conv-1",
      phone_number: opts.from ?? "34679077777",
      contact_name: "Taras",
    },
    phone_number_id: opts.phoneNumberId,
  };
}

function sign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** Minimal fake req/res to drive handleWebhooks without a live server. */
function fakeReqRes(rawBody: string, headers: Record<string, string>) {
  const req = {
    method: "POST",
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody);
    },
  } as unknown as IncomingMessage;

  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;

  return { req, res, captured };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const KAPSO_PATH = ["api", "integrations", "kapso", "webhook"];

beforeAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      require("node:fs").unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  process.env.KAPSO_WEBHOOK_HMAC_SECRET = HMAC_SECRET;
  process.env.KAPSO_API_KEY = "kapso-test-api-key";
  process.env.KAPSO_API_BASE_URL = "https://kapso.test";
  const agent = createAgent({ name: "KapsoWorker", isLead: false, status: "idle" });
  agentId = agent.id;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  closeDb();
  delete process.env.KAPSO_WEBHOOK_HMAC_SECRET;
  delete process.env.KAPSO_API_KEY;
  delete process.env.KAPSO_API_BASE_URL;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      require("node:fs").unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("routeKapsoInbound", () => {
  test("mapping hit → dispatches a kapso-inbound task to the mapped agent", () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-task",
      agentId,
      createdAt: new Date().toISOString(),
    });
    const routing = routeKapsoInbound(makePayload({ phoneNumberId: "pn-task" }));
    expect(routing.kind).toBe("task");
    if (routing.kind !== "task") throw new Error("expected task");
    const task = getTaskById(routing.taskId);
    expect(task).not.toBeNull();
    expect(task!.taskType).toBe("kapso-inbound");
    expect(task!.agentId).toBe(agentId);
    expect(task!.task).toContain("## Source: WhatsApp (Kapso)");
  });

  test("known Kapso sender → populates requestedByUserId and skips unmapped tracker", () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-known-sender",
      agentId,
      createdAt: new Date().toISOString(),
    });
    const user = createUser({ name: "Known WhatsApp Sender" });
    linkIdentity(user.id, "kapso", "34679077778", { kind: "system", id: "test-fixture" });

    const routing = routeKapsoInbound(
      makePayload({
        phoneNumberId: "pn-known-sender",
        messageId: "wamid.KNOWN_SENDER",
        from: "+34 679 077 778",
        conversationId: "conv-known-sender",
      }),
    );

    expect(routing.kind).toBe("task");
    if (routing.kind !== "task") throw new Error("expected task");
    const task = getTaskById(routing.taskId);
    expect(task!.requestedByUserId).toBe(user.id);
    expect(getKv("integration:unmapped:kapso", "34679077778:meta")).toBeNull();
  });

  test("unknown Kapso sender → records unmapped identity and leaves task unowned", () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-unknown-sender",
      agentId,
      createdAt: new Date().toISOString(),
    });
    expect(findUserByExternalId("kapso", "34679077779")).toBeNull();

    const routing = routeKapsoInbound(
      makePayload({
        phoneNumberId: "pn-unknown-sender",
        messageId: "wamid.UNKNOWN_SENDER",
        from: "+34 679 077 779",
        conversationId: "conv-unknown-sender",
      }),
    );

    expect(routing.kind).toBe("task");
    if (routing.kind !== "task") throw new Error("expected task");
    const task = getTaskById(routing.taskId);
    expect(task!.requestedByUserId).toBeUndefined();

    const meta = getKv("integration:unmapped:kapso", "34679077779:meta");
    expect(meta?.valueType).toBe("json");
    expect(meta?.value).toMatchObject({
      sampleEventType: "kapso.message.received",
    });
    expect(String(meta?.value.sampleContext)).toContain("contact=Taras");
    expect(String(meta?.value.sampleContext)).toContain("message=wamid.UNKNOWN_SENDER");
    const count = getKv("integration:unmapped:kapso", "34679077779:count");
    expect(count?.value).toBe(1);
  });

  test("no mapping → no_mapping (does not break, no task)", () => {
    const routing = routeKapsoInbound(makePayload({ phoneNumberId: "pn-unregistered" }));
    expect(routing.kind).toBe("no_mapping");
  });

  test("workflow mapping → signals workflow dispatch", () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-wf",
      workflowId: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date().toISOString(),
    });
    const routing = routeKapsoInbound(makePayload({ phoneNumberId: "pn-wf" }));
    expect(routing.kind).toBe("workflow");
    if (routing.kind !== "workflow") throw new Error("expected workflow");
    expect(routing.workflowId).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("non-inbound (outbound/status) → skip", () => {
    const routing = routeKapsoInbound(
      makePayload({ phoneNumberId: "pn-task", direction: "outbound" }),
    );
    expect(routing.kind).toBe("skip");
  });

  test("duplicate delivery of the same message id → second is deduped", () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-dup",
      agentId,
      createdAt: new Date().toISOString(),
    });
    const messageId = "wamid.DUPLICATE_TEST";
    const first = routeKapsoInbound(makePayload({ phoneNumberId: "pn-dup", messageId }));
    expect(first.kind).toBe("task");
    const second = routeKapsoInbound(makePayload({ phoneNumberId: "pn-dup", messageId }));
    expect(second.kind).toBe("duplicate");
  });
});

describe("handleWebhooks — Kapso HMAC gate", () => {
  test("valid HMAC + mapping hit → auto-acknowledges inbound, then 200 and task routing", async () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-http",
      agentId,
      createdAt: new Date().toISOString(),
    });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const messageId = `wamid.HTTP_OK_${crypto.randomUUID()}`;
    const rawBody = JSON.stringify(makePayload({ phoneNumberId: "pn-http", messageId }));
    const { req, res, captured } = fakeReqRes(rawBody, {
      "x-webhook-signature": sign(HMAC_SECRET, rawBody),
    });
    const handled = await handleWebhooks(req, res, KAPSO_PATH);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ received: true, routing: "task" });
    await waitFor(
      () =>
        calls.some((call) => call.body.message_id === messageId) &&
        calls.some(
          (call) =>
            (call.body.reaction as { message_id?: string } | undefined)?.message_id === messageId,
        ),
    );
    const messageCalls = calls.filter(
      (call) =>
        call.body.message_id === messageId ||
        (call.body.reaction as { message_id?: string } | undefined)?.message_id === messageId,
    );
    expect(messageCalls).toHaveLength(2);
    expect(
      messageCalls.every(
        (call) => call.url === "https://kapso.test/meta/whatsapp/v24.0/pn-http/messages",
      ),
    ).toBe(true);
    expect(messageCalls.map((call) => call.body)).toContainEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
    expect(messageCalls.map((call) => call.body)).toContainEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34679077777",
      type: "reaction",
      reaction: { message_id: messageId, emoji: "👀" },
    });
  });

  test("Kapso acknowledgement failures do not block webhook success", async () => {
    putKapsoNumberMapping({
      phoneNumberId: "pn-http-ack-fail",
      agentId,
      createdAt: new Date().toISOString(),
    });
    globalThis.fetch = (async () => {
      throw new Error("kapso unavailable");
    }) as typeof fetch;

    const rawBody = JSON.stringify(
      makePayload({ phoneNumberId: "pn-http-ack-fail", messageId: "wamid.HTTP_ACK_FAIL" }),
    );
    const { req, res, captured } = fakeReqRes(rawBody, {
      "x-webhook-signature": sign(HMAC_SECRET, rawBody),
    });
    const handled = await handleWebhooks(req, res, KAPSO_PATH);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ received: true, routing: "task" });
  });

  test("valid HMAC + no mapping → 200 no_mapping (fallback, does not break)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;

    const rawBody = JSON.stringify(
      makePayload({ phoneNumberId: "pn-http-unmapped", messageId: "wamid.HTTP_NOMAP" }),
    );
    const { req, res, captured } = fakeReqRes(rawBody, {
      "x-webhook-signature": sign(HMAC_SECRET, rawBody),
    });
    await handleWebhooks(req, res, KAPSO_PATH);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ routing: "no_mapping" });
  });

  test("invalid HMAC → 401", async () => {
    const rawBody = JSON.stringify(
      makePayload({ phoneNumberId: "pn-http", messageId: "wamid.HTTP_BAD" }),
    );
    const { req, res, captured } = fakeReqRes(rawBody, {
      "x-webhook-signature": sign("wrong-secret", rawBody),
    });
    await handleWebhooks(req, res, KAPSO_PATH);
    expect(captured.status).toBe(401);
  });

  test("missing signature → 401", async () => {
    const rawBody = JSON.stringify(
      makePayload({ phoneNumberId: "pn-http", messageId: "wamid.HTTP_NOSIG" }),
    );
    const { req, res, captured } = fakeReqRes(rawBody, {});
    await handleWebhooks(req, res, KAPSO_PATH);
    expect(captured.status).toBe(401);
  });
});
