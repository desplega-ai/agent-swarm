import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { App, webApi } from "@slack/bolt";
import { sendKapsoText } from "../integrations/kapso/client";
import { installSlackEgressScrub } from "../slack/egress-scrub";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { NotifyExecutor } from "../workflows/executors/notify";

// Built at runtime so no secret-shaped literal sits in the repo.
const SECRET = `ghp_${"Z".repeat(36)}`;
const REDACTED = "[REDACTED:";

type Captured = { method: string; body: string; params: URLSearchParams };

const captured: Captured[] = [];
const uploads: Uint8Array[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
  installSlackEgressScrub();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/upload/")) {
        // web-api posts the file as multipart form data under the `body` field.
        const file = (await req.formData()).get("body") as Blob;
        uploads.push(new Uint8Array(await file.arrayBuffer()));
        return new Response("OK");
      }
      const method = pathname.replace(/^\/api\//, "");
      const body = await req.text();
      captured.push({ method, body, params: new URLSearchParams(body) });
      if (method === "files.getUploadURLExternal") {
        return Response.json({ ok: true, upload_url: `${baseUrl}upload/F1`, file_id: "F1" });
      }
      if (method === "files.completeUploadExternal") {
        return Response.json({ ok: true, files: [{ id: "F1" }] });
      }
      return Response.json({ ok: true, ts: "1.000001", channel: "C1", messages: [] });
    },
  });
  baseUrl = `http://localhost:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  captured.length = 0;
  uploads.length = 0;
});

function client(): InstanceType<typeof webApi.WebClient> {
  return new webApi.WebClient("xoxb-test", {
    slackApiUrl: `${baseUrl}api/`,
    retryConfig: { retries: 0 },
  });
}

function lastCall(method: string): Captured {
  const call = captured.findLast((c) => c.method === method);
  if (!call) throw new Error(`no ${method} call captured`);
  return call;
}

function expectRedacted(text: string | null | undefined): void {
  expect(text).toBeTruthy();
  expect(text).not.toContain(SECRET);
  expect(text).toContain(REDACTED);
}

describe("Slack client egress scrub", () => {
  test("chat.postMessage scrubs text and keeps Block Kit structure", async () => {
    await client().chat.postMessage({
      channel: "C1",
      text: `deploy key ${SECRET}`,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `token: ${SECRET} end` } },
        { type: "divider" },
      ],
    });
    const call = lastCall("chat.postMessage");
    expect(call.body).not.toContain(SECRET);
    expectRedacted(call.params.get("text"));
    const blocks = JSON.parse(call.params.get("blocks") ?? "null");
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toStartWith("token: ");
    expect(blocks[0].text.text).toEndWith(" end");
    expectRedacted(blocks[0].text.text);
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(call.params.get("channel")).toBe("C1");
  });

  test("chat.update and chat.postEphemeral are scrubbed", async () => {
    const c = client();
    await c.chat.update({
      channel: "C1",
      ts: "1.0",
      text: `edit ${SECRET}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    await c.chat.postEphemeral({ channel: "C1", user: "U1", text: `psst ${SECRET}` });
    expectRedacted(lastCall("chat.update").params.get("text"));
    expectRedacted(lastCall("chat.postEphemeral").params.get("text"));
  });

  test("files.uploadV2 scrubs text content, comment and title", async () => {
    await client().files.uploadV2({
      channel_id: "C1",
      content: `line one\nexport GH=${SECRET}\n`,
      filename: "report.txt",
      title: `report ${SECRET}`,
      initial_comment: `see ${SECRET}`,
    });
    expect(uploads).toHaveLength(1);
    const uploaded = new TextDecoder().decode(uploads[0]);
    expect(uploaded).toStartWith("line one\n");
    expectRedacted(uploaded);
    const complete = lastCall("files.completeUploadExternal");
    expect(complete.body).not.toContain(SECRET);
    expectRedacted(complete.params.get("initial_comment"));
    expectRedacted(complete.params.get("files"));
  });

  test("binary uploads pass through byte-identical", async () => {
    const bytes = Buffer.concat([Buffer.from([0, 255, 1, 254]), Buffer.from(SECRET)]);
    await client().files.uploadV2({ channel_id: "C1", file: bytes, filename: "blob.bin" });
    expect(uploads).toHaveLength(1);
    expect(Buffer.from(uploads[0]).equals(bytes)).toBe(true);
  });

  test("a second install does not double-wrap", async () => {
    const proto = webApi.WebClient.prototype;
    const before = proto.apiCall;
    installSlackEgressScrub();
    expect(proto.apiCall).toBe(before);
  });

  test("a Bolt App built after install scrubs app.client sends", async () => {
    const app = new App({
      token: "xoxb-test",
      signingSecret: "test-signing-secret",
      tokenVerificationEnabled: false,
      clientOptions: { slackApiUrl: `${baseUrl}api/`, retryConfig: { retries: 0 } },
    });
    await app.client.chat.postMessage({
      channel: "C1",
      text: `bolt ${SECRET}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    expectRedacted(lastCall("chat.postMessage").params.get("text"));
  });
});

describe("WhatsApp and notify egress scrub", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sendKapsoText scrubs the message body", async () => {
    let sent = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = init.body as string;
      return Response.json({ messages: [{ id: "wamid.X" }] });
    }) as typeof fetch;
    const result = await sendKapsoText({
      apiBaseUrl: "https://kapso.invalid",
      apiKey: "k",
      phoneNumberId: "1",
      to: "2",
      body: `hola ${SECRET}`,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(sent) as { text: { body: string } };
    expect(body.text.body).toStartWith("hola ");
    expectRedacted(body.text.body);
  });

  test("notify executor scrubs the message before posting and in its output", async () => {
    const posted: string[] = [];
    const deps = {
      db: {
        postMessage: (_channel: string, _agent: string | null, content: string) => {
          posted.push(content);
          return { id: "m1" };
        },
      },
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (template: string, ctx: Record<string, unknown>) =>
        template.replace("{{v}}", String(ctx.v)),
    } as unknown as ExecutorDependencies;
    const result = await new NotifyExecutor(deps).run({
      config: { channel: "swarm", target: "chan", template: "value {{v}}" },
      context: { v: SECRET },
      meta: {
        runId: "00000000-0000-0000-0000-000000000001",
        stepId: "00000000-0000-0000-0000-000000000002",
        nodeId: "n",
        workflowId: "00000000-0000-0000-0000-000000000003",
        dryRun: false,
      },
    });
    expect(result.status).toBe("success");
    expectRedacted(posted[0]);
    expectRedacted((result.output as { message: string }).message);
  });
});
