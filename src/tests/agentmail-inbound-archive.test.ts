import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Webhook } from "svix";
import triage from "../../scripts/contact-inbox-triage";
import { initAgentMail, resetAgentMail } from "../agentmail/app";
import {
  archiveInboundMessage,
  INBOUND_ARCHIVE_TTL_MS,
  inboundArchiveKey,
} from "../agentmail/inbound-archive";
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
      async kv_set(input: Parameters<typeof upsertKv>[0] & { expiresInSec?: number }) {
        KvNamespaceSchema.parse(input.namespace);
        KvKeySchema.parse(input.key);
        await upsertKv({
          ...input,
          expiresAt: input.expiresInSec ? Date.now() + input.expiresInSec * 1000 : null,
        });
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
    expect(result.archiveAtAck?.value).toMatchObject({
      payload: {
        event_type: payload().event_type,
        message: { message_id: payload().message!.message_id },
      },
    });
  });
  test("stores only bounded discovery fields and scrubs credentials before truncation", async () => {
    const event = payload();
    const token = `ghp_${"a".repeat(36)}`;
    Object.assign(event.message!, {
      subject: `${token} ${"s".repeat(500)}`,
      text: `${token} ${"t".repeat(20000)}`,
      html: "h".repeat(20000),
      headers: { authorization: "Bearer private-credential" },
      extra: "unexpected-secret",
      attachments: [
        {
          filename: "pitch.zip",
          content_type: "application/zip",
          size: 123,
          attachment_id: "private-id",
          content: "private-bytes",
        },
      ],
    });
    await archiveInboundMessage(event);
    const entry = await getKv(namespace, key(event.message!.message_id));
    const value = entry!.value as {
      capturedAt: string;
      payload: { message: Record<string, unknown> };
    };
    const message = value.payload.message;
    expect(Object.keys(message).sort()).toEqual(
      [
        "inbox_id",
        "message_id",
        "thread_id",
        "from_",
        "reply_to",
        "subject",
        "text",
        "html",
        "timestamp",
        "labels",
        "attachments",
      ].sort(),
    );
    expect(String(message.subject)).toHaveLength(300);
    expect(String(message.text)).toHaveLength(16000);
    expect(String(message.html)).toHaveLength(16000);
    expect(JSON.stringify(value)).not.toContain(token);
    expect(JSON.stringify(value)).not.toContain("private-");
    expect(JSON.stringify(value)).not.toContain("unexpected-secret");
    expect(message.attachments).toEqual([
      { filename: "pitch.zip", content_type: "application/zip", size: 123 },
    ]);
    expect(entry!.expiresAt).toBe(Date.parse(value.capturedAt) + INBOUND_ARCHIVE_TTL_MS);
    const triaged = await triage({ dryRun: true }, context());
    expect(triaged.briefs[0]?.flag).toBe("IGNORE");
  });
  test("live retries preserve content and expiry; expired replay starts a new window", async () => {
    const event = payload();
    await archiveInboundMessage(event);
    const first = await getKv(namespace, key(event.message!.message_id));
    event.message!.subject = "Changed retry";
    await archiveInboundMessage(event);
    expect(await getKv(namespace, key(event.message!.message_id))).toEqual(first);
    await getDbClient().run("UPDATE kv_entries SET expires_at = ? WHERE namespace = ?", [
      Date.now() - 1,
      namespace,
    ]);
    const expired = await triage({ dryRun: true }, context());
    expect(expired.briefs).toHaveLength(0);
    expect(expired.controls.countsValid).toBe(false);
    await archiveInboundMessage(event);
    const replay = await getKv(namespace, key(event.message!.message_id));
    expect(replay?.value).toMatchObject({ payload: { message: { subject: "Changed retry" } } });
    expect(replay!.expiresAt).toBeGreaterThan(Date.now());
  });
  test("new captures physically sweep expired archive rows", async () => {
    await archiveInboundMessage(payload("expired"));
    await getDbClient().run("UPDATE kv_entries SET expires_at = ? WHERE namespace = ?", [
      Date.now() - 1,
      namespace,
    ]);
    await archiveInboundMessage(payload("fresh"));
    const rows = await getDbClient().query("SELECT key FROM kv_entries WHERE namespace = ?", [
      namespace,
    ]);
    expect(rows).toEqual([{ key: key("fresh") }]);
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
  test("concurrent retries preserve one minimized message, distinct inboxes remain separate", async () => {
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
    const marker = await getKv("contact-triage-messages", key("message-00"));
    expect(marker!.expiresAt).toBeGreaterThan(Date.now());
    expect(marker!.expiresAt).toBeLessThanOrEqual(Date.now() + INBOUND_ARCHIVE_TTL_MS);
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

describe("contact enrichment approval", () => {
  async function setup() {
    const event = payload();
    event.message!.from_ = "Alex Rivera <private-local@acme.example>";
    event.message!.text =
      "Our developer team wants a Desplega pilot. https://github.com/alex-rivera?secret=private-value#private-fragment";
    await archiveInboundMessage(event);
    const dns = mock(async (..._args: unknown[]) => ({
      Status: 0,
      Answer: [{ type: 15, data: "10 mx.acme.example" }],
    }));
    const exa = mock(async (..._args: unknown[]) => ({ results: [] }));
    const github = mock(async (..._args: unknown[]) => ({ data: { user: null } }));
    const ctx = context();
    ctx.stdlib.fetchJson = dns;
    ctx.api = { exa: { search: exa }, ghGraphql: { graphql: github } } as unknown as typeof ctx.api;
    return { ctx, dns, exa, github };
  }

  test("omitted and empty approvals make zero outbound calls and retain local triage", async () => {
    const { ctx, dns, exa, github } = await setup();
    for (const enrichment of [undefined, {}]) {
      const result = await triage({ dryRun: true, enrichment }, ctx);
      expect(result.controls.ok).toBe(true);
      expect(result.briefs[0]?.flag).toBe("NEEDS_HUMAN");
      expect(result.specGaps.join(" ")).toContain("enrichment disabled");
    }
    expect(dns).not.toHaveBeenCalled();
    expect(exa).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  test("each provider needs its own exact approval and receives only the approved identifier", async () => {
    const { ctx, dns, exa, github } = await setup();
    await triage({ dryRun: true, enrichment: { dnsDomains: ["acme.example"] } }, ctx);
    expect(dns).toHaveBeenCalledTimes(1);
    expect(exa).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
    expect(dns.mock.calls[0]?.[0]).toBe("https://dns.google/resolve?name=acme.example&type=MX");
    await triage({ dryRun: true, enrichment: { exaDomains: ["acme.example"] } }, ctx);
    expect(dns).toHaveBeenCalledTimes(1);
    expect(exa).toHaveBeenCalledWith({
      body: { query: "site:acme.example", numResults: 3, type: "fast" },
    });
    expect(github).not.toHaveBeenCalled();
    await triage({ dryRun: true, enrichment: { githubLogins: ["alex-rivera"] } }, ctx);
    expect(github).toHaveBeenCalledWith(expect.any(String), { login: "alex-rivera" });
    expect(exa).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify([dns.mock.calls, exa.mock.calls, github.mock.calls]);
    for (const privateField of [
      "Alex Rivera",
      "private-local",
      "private-value",
      "private-fragment",
      "pilot",
    ]) {
      expect(sent).not.toContain(privateField);
    }
  });

  test("nonmatching allowlists cannot enable calls", async () => {
    const { ctx, dns, exa, github } = await setup();
    await triage(
      {
        dryRun: true,
        enrichment: {
          dnsDomains: ["example" + ".org"],
          exaDomains: ["sub.acme.example"],
          githubLogins: ["someone-else"],
        },
      },
      ctx,
    );
    expect(dns).not.toHaveBeenCalled();
    expect(exa).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  test("malformed approval identifiers fail closed before provider calls", async () => {
    const { ctx, dns, exa, github } = await setup();
    for (const enrichment of [
      { dnsDomains: ["*.example"] },
      { exaDomains: ["acme.example secret"] },
      { githubLogins: ["alex-rivera?token=private"] },
    ]) {
      await expect(triage({ dryRun: true, enrichment }, ctx)).rejects.toThrow();
    }
    expect(dns).not.toHaveBeenCalled();
    expect(exa).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });
});
