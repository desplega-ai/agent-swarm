import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import "../http/all-routes";
import { isPublicRoute } from "../http/route-def";
import { handleTelemetryUi } from "../http/telemetry-ui";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { _resetTelemetryStateForTests, initTelemetry } from "../telemetry";
import { UI_EVENT_NAMES, validateUiEvent } from "../telemetry-ui-events";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const URL_PATH = "/api/telemetry/ui-event";
const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test" };

function jsonReq(body: unknown) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = "POST";
  req.url = URL_PATH;
  req.headers = { "content-type": "application/json" };
  return req;
}

async function post(body: unknown, auth: HttpRequestAuth = OPERATOR) {
  const req = jsonReq(body);
  setRequestAuth(req as never, auth);
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  const handled = await handleTelemetryUi(
    req as never,
    res as never,
    getPathSegments(req.url),
    parseQueryParams(req.url),
    undefined,
  );
  return { handled, statusCode, body: chunks.join("") };
}

type Sent = { event: string; source: string; properties: Record<string, unknown> };

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("POST /api/telemetry/ui-event", () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.ANONYMIZED_TELEMETRY;
  let sent: Sent[];

  beforeAll(() => {
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = originalFlag;
    _resetTelemetryStateForTests();
  });

  beforeEach(async () => {
    sent = [];
    process.env.ANONYMIZED_TELEMETRY = "true";
    _resetTelemetryStateForTests();
    await initTelemetry(
      "api-server",
      async (key) => {
        if (key === "telemetry_installation_id") return "install_0123456789abcdef";
        if (key === "telemetry_org_id") return "org_0123456789abcdef";
        return undefined;
      },
      async () => {},
    );
  });

  afterEach(() => {
    process.env.ANONYMIZED_TELEMETRY = "true";
  });

  test("an allowlisted event is sent with the ui emitter", async () => {
    const result = await post({
      event: "popup.shown",
      properties: { popup: "org_name", trigger: "missing_org_name" },
    });
    await flush();
    expect(result.statusCode).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe("popup.shown");
    expect(sent[0]?.source).toBe("ui");
    expect(sent[0]?.properties).toMatchObject({ popup: "org_name", trigger: "missing_org_name" });
  });

  test("lead.captured with an invented submission_id gets 400 and sends nothing", async () => {
    // The API never sees the Slack Connect submission, so it cannot vouch for a lead.
    const result = await post({
      event: "lead.captured",
      properties: { channel: "slack_connect", consent: true, submission_id: "invented" },
    });
    await flush();
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain("unknown event");
    expect(sent).toHaveLength(0);
  });

  test("an unknown event name gets 400 and sends nothing", async () => {
    const result = await post({ event: "task.created", properties: {} });
    await flush();
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain("unknown event");
    expect(sent).toHaveLength(0);
  });

  test("an invalid property gets 400", async () => {
    const result = await post({
      event: "popup.dismissed",
      properties: { popup: "org_name", method: "swipe" },
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain("method");
  });

  test("telemetry off answers 204 and sends nothing", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const result = await post({
      event: "popup.shown",
      properties: { popup: "feedback", trigger: "quarterly" },
    });
    await flush();
    expect(result.statusCode).toBe(204);
    expect(sent).toHaveLength(0);
  });

  test("a guest page session gets 403", async () => {
    const result = await post(
      { event: "popup.shown", properties: { popup: "feedback", trigger: "quarterly" } },
      { kind: "guest" },
    );
    expect(result.statusCode).toBe(403);
  });

  test("the route requires the API key (not public), so no auth is a 401", () => {
    expect(isPublicRoute("POST", ["api", "telemetry", "ui-event"])).toBe(false);
  });
});

describe("validateUiEvent", () => {
  test("allows only ui events", () => {
    expect(UI_EVENT_NAMES).toContain("popup.shown");
    expect(UI_EVENT_NAMES).toContain("notification.submitted");
    // Server-attributed; the route cannot verify the submission behind it.
    expect(UI_EVENT_NAMES).not.toContain("lead.captured");
    expect(UI_EVENT_NAMES).not.toContain("task.created");
    // The API sends it after an admin-only change; a dashboard user cannot fake it.
    expect(UI_EVENT_NAMES).not.toContain("used_by.consent_changed");
  });

  test("rejects missing required, unknown keys, wrong types and values below minimum", () => {
    expect(validateUiEvent("popup.shown", { popup: "feedback" })).toEqual([
      'missing required property "trigger"',
    ]);
    expect(validateUiEvent("notification.viewed", { key: "x", is_cloud: true })).toEqual([
      'unknown property "is_cloud"',
    ]);
    expect(
      validateUiEvent("popup.submitted", {
        popup: "feedback",
        score: -1,
        has_message: "yes",
        has_contact: false,
      }),
    ).toEqual(['"score" must be at least 0', '"has_message" must be a boolean']);
    expect(validateUiEvent("notification.viewed", { key: "k".repeat(201) })).toEqual([
      '"key" must be at most 200 characters',
    ]);
    expect(validateUiEvent("org.profile_updated", { fields: ["name"], surface: "prompt" })).toEqual(
      [],
    );
  });
});
