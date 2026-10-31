// Mock inference host for the black-box runner.
//
// One Bun.serve() speaks three contracts the API server reaches over HTTP:
//   - OpenAI-compatible chat + embeddings (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`,
//     `/v1/models`, `/v1/key`). The SUT is pointed at it through
//     OPENROUTER_BASE_URL + OPENROUTER_API_KEY (workflow-llm, raw-llm, memory rater,
//     session summaries, key probes) and EMBEDDING_API_BASE_URL + EMBEDDING_API_KEY
//     (memory embeddings).
//   - SystemOne decisions + extraction (`/v1/systemone`), reached through the `laya`
//     provider's LAYA_URL global config row.
//
// Every request is journaled so scenarios can assert what the server sent. Responses
// are deterministic by default and scriptable per scenario through the responder hooks.
// The mock never imports from src/: scripts/check-e2e-boundary.sh forbids it.
import { createHash } from "node:crypto";

export type MockRequest = {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  response_format?: { type?: string; json_schema?: { schema?: unknown; name?: string } };
  tools?: Array<{
    type?: string;
    function?: { name?: string; parameters?: unknown };
    /** Responses API tools carry name + parameters at the top level. */
    name?: string;
    parameters?: unknown;
  }>;
  tool_choice?: unknown;
  stream?: boolean;
  /** Responses API: the prompt items, or one plain string. */
  input?: unknown;
  /** Responses API: `text.format` carries the JSON schema. */
  text?: { format?: { type?: string; schema?: unknown; name?: string } };
  [key: string]: unknown;
};

/**
 * A responder answers one chat completion. Return a string for plain text, an object
 * for JSON output (stringified for the wire), or `undefined` to fall through to the
 * default synthesizer. Throw `MockLlmHttpError` to answer with an error status.
 */
export type ChatResponder = (
  request: ChatRequest,
  schema: unknown,
) => string | object | undefined | Promise<string | object | undefined>;

export type SystemOneResponder = (body: Record<string, unknown>) => unknown | Promise<unknown>;

export class MockLlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const DEFAULT_DIMENSIONS = 512;
export const MOCK_MODEL_ID = "e2e/mock-model";
export const MOCK_API_KEY = "e2e-mock-inference-key";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Builds a value that satisfies a JSON schema: every declared property, type-appropriate
 * placeholder leaves, the first enum entry, `const` verbatim. Good enough for the
 * server's own validators; a scenario that needs specific content installs a responder.
 */
export function synthesizeFromSchema(schema: unknown, depth = 0): unknown {
  const node = asRecord(schema);
  if (!node || depth > 8) return "e2e";
  if ("const" in node) return node.const;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    return synthesizeFromSchema(node.anyOf[0], depth + 1);
  }
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    return synthesizeFromSchema(node.oneOf[0], depth + 1);
  }
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "object": {
      const properties = asRecord(node.properties) ?? {};
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        result[key] = synthesizeFromSchema(child, depth + 1);
      }
      return result;
    }
    case "array": {
      const min = typeof node.minItems === "number" ? node.minItems : 1;
      return Array.from({ length: Math.max(1, min) }, () =>
        synthesizeFromSchema(node.items, depth + 1),
      );
    }
    case "integer":
      return typeof node.minimum === "number" ? Math.ceil(node.minimum) : 1;
    case "number":
      return typeof node.minimum === "number" ? node.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "string":
      if (node.format === "date-time") return "2026-01-01T00:00:00.000Z";
      if (node.format === "date") return "2026-01-01";
      if (node.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      return "e2e";
    default:
      // Untyped schema with properties is an object in practice.
      if (node.properties) return synthesizeFromSchema({ ...node, type: "object" }, depth);
      return "e2e";
  }
}

/** Deterministic unit vector: equal texts give equal vectors, shared words pull them together. */
export function embeddingFor(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const vector = new Float64Array(dimensions);
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const terms = words.length > 0 ? words : ["empty"];
  for (const word of terms) {
    const digest = createHash("sha256").update(word).digest();
    for (let i = 0; i < 8; i++) {
      const index = digest.readUInt32BE((i * 4) % 28) % dimensions;
      const sign = (digest[i] ?? 0) % 2 === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

function lastUserText(request: ChatRequest): string {
  if (typeof request.input === "string") return request.input;
  const messages = request.messages ?? (Array.isArray(request.input) ? request.input : []);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const record = asRecord(part);
          return record && typeof record.text === "string" ? record.text : "";
        })
        .join("\n");
    }
  }
  return "";
}

function responseSchema(request: ChatRequest): unknown {
  const format = request.response_format;
  if (format?.type === "json_schema" && format.json_schema?.schema) {
    return format.json_schema.schema;
  }
  if (format?.type === "json_object") return { type: "object" };
  const textFormat = request.text?.format;
  if (textFormat?.type === "json_schema" && textFormat.schema) return textFormat.schema;
  if (textFormat?.type === "json_object") return { type: "object" };
  return undefined;
}

/** The tool the caller forced (`tool_choice: {function: {name}}`), if any. */
function forcedTool(request: ChatRequest): { name: string; parameters: unknown } | undefined {
  const choice = asRecord(request.tool_choice);
  const name = asRecord(choice?.function)?.name ?? choice?.name;
  if (typeof name !== "string") return undefined;
  for (const tool of request.tools ?? []) {
    if (tool.function?.name === name) {
      return { name, parameters: tool.function.parameters };
    }
    if (tool.name === name) return { name, parameters: tool.parameters };
  }
  return undefined;
}

/** Resolve the answer for one completion, through the responder or the synthesizer. */
async function resolveAnswer(
  request: ChatRequest,
  responder: ChatResponder | undefined,
): Promise<{ answer: string | object; schema: unknown; tool: ReturnType<typeof forcedTool> }> {
  const schema = responseSchema(request);
  const tool = forcedTool(request);
  let answer: string | object | undefined;
  if (responder) answer = await responder(request, schema ?? tool?.parameters);
  if (answer === undefined) {
    if (schema) answer = synthesizeFromSchema(schema) as object;
    else if (tool?.parameters) answer = synthesizeFromSchema(tool.parameters) as object;
    else answer = `mock reply: ${lastUserText(request).slice(0, 200)}`;
  }
  return { answer, schema, tool };
}

export type MockLlm = Awaited<ReturnType<typeof startMockLlm>>;

export async function startMockLlm() {
  const requests: MockRequest[] = [];
  let chatResponder: ChatResponder | undefined;
  let systemOneResponder: SystemOneResponder | undefined;
  let completionCounter = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const errorResponse = (error: MockLlmHttpError) =>
    json(
      error.status,
      { error: { message: error.message, type: "e2e_mock", code: error.status } },
      error.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(error.retryAfterSeconds) },
    );

  /** OpenAI Responses API (`POST /v1/responses`), the ai SDK's default transport. */
  async function responses(request: ChatRequest): Promise<Response> {
    const { answer, tool } = await resolveAnswer(request, chatResponder);
    const content = typeof answer === "string" ? answer : JSON.stringify(answer);
    const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request.input ?? "").length / 4));
    const outputTokens = Math.max(1, Math.ceil(content.length / 4));
    const id = `resp-e2e-${++completionCounter}`;
    const output =
      tool && typeof answer !== "string"
        ? [
            {
              type: "function_call",
              id: `fc-e2e-${completionCounter}`,
              call_id: `call-e2e-${completionCounter}`,
              name: tool.name,
              arguments: content,
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: `msg-e2e-${completionCounter}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: content, annotations: [] }],
            },
          ];
    const body = {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: request.model ?? MOCK_MODEL_ID,
      output,
      incomplete_details: null,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens,
      },
    };
    if (request.stream === true) {
      const event = (type: string, payload: Record<string, unknown>) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
      const item = output[0]!;
      const stream = [
        event("response.created", { response: { ...body, status: "in_progress", output: [] } }),
        event("response.output_item.added", { output_index: 0, item }),
        ...(item.type === "message"
          ? [
              event("response.output_text.delta", {
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: content,
              }),
            ]
          : [
              event("response.function_call_arguments.delta", {
                item_id: item.id,
                output_index: 0,
                delta: content,
              }),
            ]),
        event("response.output_item.done", { output_index: 0, item }),
        event("response.completed", { response: body }),
      ].join("");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    return json(200, body);
  }

  async function chatCompletion(request: ChatRequest): Promise<Response> {
    const { answer, tool } = await resolveAnswer(request, chatResponder);
    const content = typeof answer === "string" ? answer : JSON.stringify(answer);
    const promptTokens = Math.max(1, Math.ceil(JSON.stringify(request.messages ?? []).length / 4));
    const completionTokens = Math.max(1, Math.ceil(content.length / 4));
    const id = `chatcmpl-e2e-${++completionCounter}`;
    const created = Math.floor(Date.now() / 1000);
    const model = request.model ?? MOCK_MODEL_ID;
    const message =
      tool && typeof answer !== "string"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-e2e-${completionCounter}`,
                type: "function",
                function: { name: tool.name, arguments: content },
              },
            ],
          }
        : { role: "assistant", content };
    const finish = tool && typeof answer !== "string" ? "tool_calls" : "stop";
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    if (request.stream === true) {
      const chunk = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason ? { usage } : {}),
        })}\n\n`;
      const body = [
        chunk({ role: "assistant" }, null),
        chunk(message.tool_calls ? { tool_calls: message.tool_calls } : { content }, null),
        chunk({}, finish),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    return json(200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
      usage,
    });
  }

  function embeddings(body: Record<string, unknown>): Response {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dimensions =
      typeof body.dimensions === "number" && body.dimensions > 0
        ? body.dimensions
        : DEFAULT_DIMENSIONS;
    const data = inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: embeddingFor(
        typeof input === "string" ? input : JSON.stringify(input),
        dimensions,
      ),
    }));
    const tokens = inputs.reduce<number>(
      (total, input) => total + Math.ceil(String(input).length / 4),
      0,
    );
    return json(200, {
      object: "list",
      data,
      model: typeof body.model === "string" ? body.model : "text-embedding-3-small",
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  }

  /**
   * Default SystemOne answer: every `noul` question is true with p=0.9, every `choice`
   * picks its first criterion, every `score` answers the scale minimum. Extraction fields
   * answer a typed placeholder. Scenarios that test review bands install a responder.
   */
  function defaultSystemOne(body: Record<string, unknown>): unknown {
    const model = typeof body.model === "string" ? body.model : "e2e-systemone";
    const usage = { input_tokens: 10, output_tokens: 5 };
    const questions = asRecord(body.questions);
    if (questions) {
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(questions)) {
        const spec = asRecord(question) ?? {};
        if (spec.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
        else if (spec.type === "choice") {
          const criteria = asRecord(spec.criteria) ?? {};
          const choice = Object.keys(criteria)[0] ?? "e2e";
          answers[id] = { type: "choice", choice, confidence: 0.9 };
        } else {
          const min = typeof spec.min === "number" ? spec.min : 0;
          answers[id] = { type: "score", score: min, confidence: 0.9 };
        }
      }
      return { model, answers, usage };
    }
    const fields = asRecord(body.fields);
    if (fields) {
      const answers: Record<string, unknown> = {};
      for (const [id, field] of Object.entries(fields)) {
        const spec = asRecord(field) ?? {};
        const value =
          spec.type === "number" || spec.type === "estimate" || spec.type === "forecast"
            ? 1
            : spec.type === "list"
              ? ["e2e"]
              : spec.type === "date"
                ? "2026-01-01"
                : "e2e";
        answers[id] = { value, confidence: 0.9, spans: [] };
      }
      return { model, answers, truncated: false, usage };
    }
    return { model, answers: {}, usage };
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const path = url.pathname.replace(/\/+$/, "") || "/";
      let body: unknown = null;
      if (method !== "GET" && method !== "HEAD") {
        const text = await req.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }
      requests.push({
        at: Date.now(),
        method,
        path,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      try {
        if (method === "POST" && /\/chat\/completions$/.test(path)) {
          return await chatCompletion((asRecord(body) ?? {}) as ChatRequest);
        }
        if (method === "POST" && /\/responses$/.test(path)) {
          return await responses((asRecord(body) ?? {}) as ChatRequest);
        }
        if (method === "POST" && /\/embeddings$/.test(path)) {
          return embeddings(asRecord(body) ?? {});
        }
        if (method === "GET" && /\/models$/.test(path)) {
          return json(200, {
            object: "list",
            data: [{ id: MOCK_MODEL_ID, object: "model", owned_by: "e2e" }],
          });
        }
        if (method === "GET" && /\/(key|auth\/key)$/.test(path)) {
          return json(200, { data: { label: "e2e", usage: 0, limit: null, is_free_tier: false } });
        }
        if (method === "POST" && /\/systemone$/.test(path)) {
          const record = asRecord(body) ?? {};
          const answer = systemOneResponder
            ? await systemOneResponder(record)
            : defaultSystemOne(record);
          return json(200, answer, { "x-request-id": `e2e-s1-${requests.length}` });
        }
        return json(404, { error: { message: `mock inference: no route for ${method} ${path}` } });
      } catch (error) {
        if (error instanceof MockLlmHttpError) return errorResponse(error);
        return json(500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    /** OpenAI-compatible base URL, the value for OPENROUTER_BASE_URL and EMBEDDING_API_BASE_URL. */
    baseUrl: `${origin}/v1`,
    apiKey: MOCK_API_KEY,
    /** The environment the SUT needs to route inference here. */
    env: {
      OPENROUTER_API_KEY: MOCK_API_KEY,
      OPENROUTER_BASE_URL: `${origin}/v1`,
      EMBEDDING_API_KEY: MOCK_API_KEY,
      EMBEDDING_API_BASE_URL: `${origin}/v1`,
    } as Record<string, string>,
    requests: requests as readonly MockRequest[],
    /** Requests whose path ends with `suffix`, newest last. */
    requestsTo(suffix: string): MockRequest[] {
      return requests.filter((request) => request.path.endsWith(suffix));
    },
    /** Install (or clear with `undefined`) the chat responder for the current scenario. */
    setChatResponder(responder: ChatResponder | undefined): void {
      chatResponder = responder;
    },
    setSystemOneResponder(responder: SystemOneResponder | undefined): void {
      systemOneResponder = responder;
    },
    /** Scenario hygiene: clear responders so the next scenario starts from defaults. */
    reset(): void {
      chatResponder = undefined;
      systemOneResponder = undefined;
    },
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
