import { createHmac } from "node:crypto";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { ScenarioContext } from "../run";

// ─── MCP tools ───────────────────────────────────────────────────────────────

/** What an MCP tool answered, flattened so every assertion reads the same. */
export type ToolOutcome = {
  isError: boolean;
  text: string;
  /** `structuredContent.message`, or "" when the tool sent none. */
  message: string;
  data: Record<string, unknown>;
};

/** Calls a tool. A call the server rejects before the tool runs comes back as an error outcome. */
export async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(await connection.callTool(name, args));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { isError: true, text, message: text, data: {} };
  }
  const content = Array.isArray(raw.content) ? raw.content : [];
  const text = content
    .map((item) => {
      const block = asRecord(item);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
  const data =
    typeof raw.structuredContent === "object" &&
    raw.structuredContent !== null &&
    !Array.isArray(raw.structuredContent)
      ? (raw.structuredContent as Record<string, unknown>)
      : {};
  return {
    isError: raw.isError === true,
    text,
    message: typeof data.message === "string" ? data.message : "",
    data,
  };
}

/** The tool succeeded and both channels agree. */
export function expectToolOk(outcome: ToolOutcome, label: string): ToolOutcome {
  expect(!outcome.isError, `${label}: tool returned isError: ${outcome.text.slice(0, 300)}`);
  expect(outcome.data.success === true, `${label}: structuredContent.success is not true`);
  expect(outcome.message.length > 0, `${label}: structuredContent.message is empty`);
  expect(outcome.text.includes(outcome.message), `${label}: text content lacks the message`);
  return outcome;
}

/** The tool failed with `isError` and its message contains `includes`. */
export function expectToolError(
  outcome: ToolOutcome,
  label: string,
  includes: string,
): ToolOutcome {
  expect(outcome.isError, `${label}: expected isError, got: ${outcome.text.slice(0, 300)}`);
  expect(outcome.data.success === false, `${label}: structuredContent.success is not false`);
  expect(
    outcome.text.toLowerCase().includes(includes.toLowerCase()),
    `${label}: error text lacks "${includes}": ${outcome.text.slice(0, 300)}`,
  );
  return outcome;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

/** Registers a worker (or a lead) and returns its id. Names carry the nonce. */
export async function registerAgent(
  ctx: ScenarioContext,
  label: string,
  options: { lead?: boolean } = {},
): Promise<string> {
  const name = `platform-${label}-${ctx.nonce}`;
  const response = await ctx.api("POST", "/api/agents", {
    body: options.lead ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register ${name}`);
  return asString(asRecord(response.json).id, `${name} id`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type ConfigInput = {
  key: string;
  value: string;
  scope?: "global" | "agent" | "repo";
  scopeId?: string | null;
  isSecret?: boolean;
  description?: string;
  exportToEnv?: boolean;
};

/** PUT /api/config and return the stored row. */
export async function putConfig(
  ctx: ScenarioContext,
  input: ConfigInput,
  query = "",
): Promise<Record<string, unknown>> {
  const response = await ctx.api("PUT", `/api/config${query}`, {
    body: {
      scope: input.scope ?? "global",
      scopeId: input.scopeId ?? null,
      key: input.key,
      value: input.value,
      isSecret: input.isSecret ?? false,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.exportToEnv !== undefined ? { exportToEnv: input.exportToEnv } : {}),
    },
  });
  expectStatus(response, [200], `PUT /api/config ${input.key}`);
  return asRecord(response.json);
}

/** DELETE /api/config/{id}. */
export async function deleteConfig(ctx: ScenarioContext, id: string): Promise<void> {
  expectStatus(await ctx.api("DELETE", `/api/config/${id}`), [200], `DELETE config ${id}`);
}

/** POST /api/config/reload and return its body. */
export async function reloadConfig(ctx: ScenarioContext): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/config/reload", { body: {} });
  expectStatus(response, [200], "reload config");
  return asRecord(response.json);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** Undo steps run in reverse order, even when the scenario failed. */
export function cleanupStack(ctx: ScenarioContext) {
  const steps: Array<{ label: string; fn: () => Promise<void> }> = [];
  return {
    add(label: string, fn: () => Promise<void>) {
      steps.push({ label, fn });
    },
    async run() {
      for (const step of steps.reverse()) {
        try {
          await step.fn();
        } catch (error) {
          ctx.log(
            `cleanup "${step.label}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  };
}

// ─── Local mock servers ──────────────────────────────────────────────────────

export type MockRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  text: string;
  json: unknown;
  form: URLSearchParams;
};

export type MockServer = {
  origin: string;
  requests: MockRequest[];
  stop: () => void;
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A loopback HTTP server the API reaches as a stand-in for a third-party provider
 * (OAuth token endpoint, Kapso, Composio...). Records every request it gets.
 */
export function startMockServer(
  handler: (request: MockRequest) => Response | Promise<Response>,
): MockServer {
  const requests: MockRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const mock: MockRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        text,
        json,
        form: new URLSearchParams(
          request.headers.get("content-type")?.includes("x-www-form-urlencoded") ? text : "",
        ),
      };
      requests.push(mock);
      return handler(mock);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => void server.stop(true),
  };
}

// ─── Crypto ──────────────────────────────────────────────────────────────────

/** `sha256=<hex>` HMAC of a body, the signature shape webhook providers send. */
export function hmacSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** An unsigned JWT-shaped string that carries `payload` (enough for plan and email decoding). */
export function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.e2esig`;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export type ComposedUser = {
  id: string;
  name: string;
  email?: string | null;
  emailAliases: string[];
  status: string;
  identities: Array<{ kind: string; externalId: string }>;
  tokens: Array<{
    id: string;
    userId: string;
    label: string | null;
    tokenPreview: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    eventType: string;
    actor: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
  [key: string]: unknown;
};

/** Reads `{ user }` out of a users-route response. */
export function userOf(json: unknown): ComposedUser {
  return asRecord(asRecord(json).user) as unknown as ComposedUser;
}

/** POST /api/users and return the composed user. */
export async function createUser(
  ctx: ScenarioContext,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<ComposedUser> {
  const response = await ctx.api("POST", "/api/users", {
    body: { name: `Platform ${label} ${ctx.nonce}`, ...extra },
  });
  expectStatus(response, [200], `create user ${label}`);
  return userOf(response.json);
}
