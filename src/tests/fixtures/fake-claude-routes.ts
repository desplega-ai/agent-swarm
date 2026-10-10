/**
 * Fake model endpoints for the claude route e2e (issue #1800). Each server
 * answers the request shapes Claude Code 2.1.286 sends on its route and
 * records every request, so a test can assert path, auth header, and that no
 * subscription token arrived.
 *
 * - gateway: Anthropic Messages at `{base}/v1/messages` (SSE), `/v1/models`.
 * - foundry: the same API under `{base}/anthropic` (ANTHROPIC_FOUNDRY_BASE_URL).
 * - bedrock: `/model/{id}/invoke` (JSON), `/model/{id}/invoke-with-response-stream`
 *   (AWS event stream), and the `/inference-profiles` control-plane list.
 * - vertex: `/v1/projects/{p}/locations/{r}/publishers/anthropic/models/{m}:streamRawPredict`
 *   (SSE) and `:rawPredict` (JSON).
 */

export type FakeRouteKind = "gateway" | "foundry" | "bedrock" | "vertex";

export interface CapturedRequest {
  method: string;
  /** Path plus query string. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeRouteServer {
  baseUrl: string;
  requests: CapturedRequest[];
  stop(): void;
}

function anthropicEvents(model: string, text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fake_route",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

function anthropicMessage(model: string, text: string): Record<string, unknown> {
  return {
    id: "msg_fake_route",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

function sseResponse(model: string, text: string): Response {
  const body = anthropicEvents(model, text)
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One AWS event-stream frame: prelude, CRC, string headers, payload, CRC. */
function eventStreamFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(part.buffer);
    part[0] = nameBytes.length;
    part.set(nameBytes, 1);
    part[1 + nameBytes.length] = 7; // string
    view.setUint16(2 + nameBytes.length, valueBytes.length);
    part.set(valueBytes, 4 + nameBytes.length);
    headerParts.push(part);
  }
  const headersLength = headerParts.reduce((n, p) => n + p.length, 0);
  const total = 12 + headersLength + payload.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  view.setUint32(8, Bun.hash.crc32(frame.subarray(0, 8)));
  let offset = 12;
  for (const part of headerParts) {
    frame.set(part, offset);
    offset += part.length;
  }
  frame.set(payload, offset);
  view.setUint32(total - 4, Bun.hash.crc32(frame.subarray(0, total - 4)));
  return frame;
}

/** Bedrock's InvokeModelWithResponseStream: each Anthropic event base64'd in a `chunk` frame. */
function bedrockStreamResponse(model: string, text: string): Response {
  const encoder = new TextEncoder();
  const frames = anthropicEvents(model, text).map((event) =>
    eventStreamFrame(
      { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
      encoder.encode(
        JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }),
      ),
    ),
  );
  return new Response(Buffer.concat(frames), {
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

function requestedModel(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : fallback;
  } catch {
    return fallback;
  }
}

function wantsStream(body: string): boolean {
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

function answer(kind: FakeRouteKind, req: CapturedRequest, reply: string): Response {
  const pathname = req.path.split("?")[0] ?? "";
  if (req.method === "HEAD") return new Response(null, { status: 200 });

  if (kind === "gateway" || kind === "foundry") {
    const prefix = kind === "foundry" ? "/anthropic" : "";
    if (req.method === "GET" && pathname === `${prefix}/v1/models`) {
      return Response.json({ data: [{ id: "claude-fake-route", type: "model" }] });
    }
    if (req.method === "POST" && pathname === `${prefix}/v1/messages`) {
      const model = requestedModel(req.body, "claude-fake-route");
      return wantsStream(req.body)
        ? sseResponse(model, reply)
        : Response.json(anthropicMessage(model, reply));
    }
  }

  if (kind === "bedrock") {
    if (req.method === "GET" && pathname === "/inference-profiles") {
      return Response.json({ inferenceProfileSummaries: [] });
    }
    const model = decodeURIComponent(pathname.match(/^\/model\/([^/]+)\//)?.[1] ?? "fake");
    if (req.method === "POST" && pathname.endsWith("/invoke-with-response-stream")) {
      return bedrockStreamResponse(model, reply);
    }
    if (req.method === "POST" && pathname.endsWith("/invoke")) {
      return Response.json(anthropicMessage(model, reply));
    }
  }

  if (kind === "vertex") {
    const model = decodeURIComponent(pathname.match(/\/models\/([^/:]+):/)?.[1] ?? "fake");
    if (req.method === "POST" && pathname.endsWith(":streamRawPredict")) {
      return sseResponse(model, reply);
    }
    if (req.method === "POST" && pathname.endsWith(":rawPredict")) {
      return Response.json(anthropicMessage(model, reply));
    }
  }

  return Response.json({ error: `fake ${kind} route: no handler` }, { status: 404 });
}

/** Starts a fake `kind` endpoint on a free port. Every reply's text is `reply`. */
export function startFakeRouteServer(kind: FakeRouteKind, reply: string): FakeRouteServer {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const captured: CapturedRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
      };
      requests.push(captured);
      return answer(kind, captured, reply);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

function redactSecret(value: string): string {
  const [scheme, token] = value.startsWith("Bearer ") ? ["Bearer ", value.slice(7)] : ["", value];
  return `${scheme}${token.slice(0, 4)}…`;
}

/** `METHOD path` plus the auth headers present, secrets reduced to their first 4 chars. */
export function redactedRequestLine(req: CapturedRequest): string {
  const auth = Object.entries(req.headers)
    .filter(([name]) => SECRET_HEADERS.has(name))
    .map(([name, value]) => `${name}: ${redactSecret(value)}`);
  return `${req.method} ${req.path}${auth.length ? ` [${auth.join(", ")}]` : " [no auth header]"}`;
}
