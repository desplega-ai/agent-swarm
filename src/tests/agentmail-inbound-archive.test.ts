import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Webhook } from "svix";
import triage from "../../scripts/contact-inbox-triage";
import { initAgentMail, resetAgentMail } from "../agentmail/app";
import { archiveInboundMessage, inboundArchiveKey } from "../agentmail/inbound-archive";
import type { AgentMailWebhookPayload } from "../agentmail/types";
import { closeDb, getDbClient, getKv, initDb, upsertKv } from "../be/db";
import { handleWebhooks } from "../http/webhooks";
import { KvKeySchema, KvNamespaceSchema } from "../types";

const inbox = "desplega-contact@agent-swarm.dev";
const namespace = "agentmail-inbound";
const key = (id: string) => inboundArchiveKey(inbox, id);
const secret = `whsec_${Buffer.from("archive-test-secret").toString("base64")}`;
const savedEnv = { ...process.env };
function payload(id = "cold-unauthenticated"): AgentMailWebhookPayload {
  return {
    type: "event",
    event_id: `event-${id}`,
    event_type: "message.received.unauthenticated",
    message: {
      inbox_id: inbox,
      message_id: id,
      thread_id: "cold-thread",
      organization_id: "test",
      from_: "Alex <alex@acme.example>",
      to: [inbox],
      cc: [],
      bcc: [],
      reply_to: [],
      subject: "Desplega pilot",
      preview: "",
      text: "Our team wants to evaluate Desplega.",
      html: null,
      labels: ["received", "unauthenticated"],
      attachments: [],
      in_reply_to: null,
      references: [],
      timestamp: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
}

beforeEach(() => {
  initDb(":memory:");
  process.env.AGENTMAIL_WEBHOOK_SECRET = secret;
  delete process.env.AGENTMAIL_DISABLE;
  // Routing rejects this inbox; capture must still happen.
  process.env.AGENTMAIL_INBOX_DOMAIN_FILTER = "other.example";
  resetAgentMail();
  initAgentMail();
});
afterEach(() => {
  closeDb();
  resetAgentMail();
  for (const key of [
    "AGENTMAIL_WEBHOOK_SECRET",
    "AGENTMAIL_DISABLE",
    "AGENTMAIL_INBOX_DOMAIN_FILTER",
  ]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function deliver(event: AgentMailWebhookPayload, valid = true) {
  const body = JSON.stringify(event);
  const timestamp = new Date();
  const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "svix-id": event.event_id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": valid ? new Webhook(secret).sign(event.event_id, timestamp, body) : "invalid",
  };
  let status = 0;
  let archiveAtAck: ReturnType<typeof getKv> | undefined;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end() {
      if (status === 200) archiveAtAck = getKv(namespace, key(event.message!.message_id));
    },
  } as unknown as ServerResponse;
  await handleWebhooks(req, res, ["api", "agentmail", "webhook"]);
  return { status, archiveAtAck: await archiveAtAck };
}

// Real in-memory SQL/KV, only provider enrichment is stubbed. There are no list
// or thread methods on this context: discovering cold mail cannot depend on them.
function context() {
  return {
    swarm: {
      async db_query({ sql, params }: { sql: string; params?: unknown[] }) {
        const rows = await getDbClient().query<Record<string, unknown>>(sql, params);
        return { success: true, rows: rows.map((row) => Object.values(row)) };
      },
      async kv_getOrNull({ namespace: ns, key }: { namespace: string; key: string }) {
        KvNamespaceSchema.parse(ns);
        KvKeySchema.parse(key);
        return await getKv(ns, key);
      },
      async kv_set(input: Parameters<typeof upsertKv>[0]) {
        KvNamespaceSchema.parse(input.namespace);
        KvKeySchema.parse(input.key);
        await upsertKv(input);
        return { success: true };
      },
    },
    stdlib: {
      async fetchJson() {
        return { Status: 0, Answer: [{ type: 15, data: "10 mx.acme.example" }] };
      },
    },
    api: {},
  } as unknown as Parameters<typeof triage>[1];
}

describe("verified inbound archive", () => {
  test("cold unauthenticated mail is durable before ACK despite routing filter", async () => {
    const result = await deliver(payload());
    expect(result.status).toBe(200);
    expect(result.archiveAtAck?.value).toMatchObject({ payload: payload() });
  });
  test("invalid signatures never enter the archive", async () => {
    expect((await deliver(payload(), false)).status).toBe(401);
    expect(await getKv(namespace, key("cold-unauthenticated"))).toBeNull();
  });
  test("storage errors return 503, and redelivery succeeds after recovery", async () => {
    await getDbClient().run("ALTER TABLE kv_entries RENAME TO unavailable_kv");
    expect((await deliver(payload())).status).toBe(503);
    await getDbClient().run("ALTER TABLE unavailable_kv RENAME TO kv_entries");
    expect((await deliver(payload())).status).toBe(200);
  });
  test("concurrent retries preserve one full message, distinct inboxes remain separate", async () => {
    await Promise.all(Array.from({ length: 8 }, () => archiveInboundMessage(payload())));
    const other = payload();
    other.message!.inbox_id = "other@example.com";
    await archiveInboundMessage(other);
    expect(
      await getDbClient().query("SELECT key FROM kv_entries WHERE namespace = ?", [namespace]),
    ).toHaveLength(2);
    expect(
      await getKv(namespace, inboundArchiveKey("other@example.com", other.message!.message_id)),
    ).not.toBeNull();
  });
  test("blocked and spam deliveries are captured without enabling task routing", async () => {
    for (const type of ["message.received.blocked", "message.received.spam"] as const) {
      const event = payload(type);
      event.event_type = type;
      expect((await deliver(event)).archiveAtAck).toBeTruthy();
    }
    const sent = payload("sent");
    sent.event_type = "message.sent";
    await archiveInboundMessage(sent);
    expect(await getKv(namespace, key("sent"))).toBeNull();
  });
  test("malformed inbound deliveries receive a retryable error", async () => {
    const event = payload();
    delete event.message;
    expect((await deliver(event)).status).toBe(503);
  });
});

describe("contact triage archive reader", () => {
  test("query and marker failures stay visible and retain pending mail", async () => {
    await archiveInboundMessage(payload());
    const brokenQuery = context();
    brokenQuery.swarm.db_query = async () => ({ success: false });
    expect((await triage({}, brokenQuery)).controls.countsValid).toBe(false);
    const brokenWrite = context();
    brokenWrite.swarm.kv_set = async () => {
      throw new Error("storage unavailable");
    };
    const result = await triage({}, brokenWrite);
    expect(result.stats.kvWritten).toBe(0);
    expect(result.controls.countsValid).toBe(false);
    expect(result.errors[0]).toContain("Failed dedupe write");
    expect((await triage({}, context())).briefs).toHaveLength(1);
  });

  test("discovers cold inbound without listing endpoints and never claims historical completeness", async () => {
    const event = payload("<cold-message@example.com>");
    event.message!.labels = [];
    await archiveInboundMessage(event);
    const result = await triage({ dryRun: true }, context());
    expect(result.briefs).toHaveLength(1);
    expect(result.briefs[0]?.flag).toBe("NEEDS_HUMAN");
    expect(result.briefs[0]?.from.address).toBe("alex@acme.example");
    expect(result.controls.ok).toBe(true);
    expect(result.stats.archiveDrained).toBe(true);
    expect(result.stats.coverageComplete).toBe(false);
    expect(result.stats.historicalCoverage).toBe("unknown");
    expect(result.stats.kvWritten).toBe(0);
  });
  test("bounded runs drain backlog, including old mail and multiple messages in one thread", async () => {
    for (let i = 0; i < 27; i++)
      await archiveInboundMessage(payload(`message-${String(i).padStart(2, "0")}`));
    const first = await triage({ limit: 26 }, context());
    expect(first.briefs).toHaveLength(26);
    expect(first.stats.kvWritten).toBe(26);
    expect(first.stats.archiveDrained).toBe(false);
    const second = await triage({}, context());
    expect(second.briefs).toHaveLength(1);
    expect(second.stats.archiveDrained).toBe(true);
    const empty = await triage({}, context());
    expect(empty.briefs).toHaveLength(0);
    expect(empty.controls.countsValid).toBe(false);
    expect(empty.stats.countsVoid).toBe(true);
  });
  test("archive failures and missing entries cannot produce valid counts or dedupe markers", async () => {
    await archiveInboundMessage(payload());
    const ctx = context();
    ctx.swarm.kv_getOrNull = async () => null;
    const result = await triage({}, ctx);
    expect(result.controls.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await getKv("contact-triage-messages", key("cold-unauthenticated"))).toBeNull();
  });
});
