/**
 * Exact request composition from a harness payload hook (pi, opencode).
 *
 * The worker's manifest (`POST /api/tasks/{id}/request-composition`, source
 * `worker`) sizes the prompt parts we assemble and estimates the rest. Pi and
 * OpenCode hand their extensions the request they are about to send, so for
 * them we measure the real system prompt, tool declarations and messages, and
 * post a `harness-hook` manifest. The server merges it with the worker's parts
 * and learns a per-provider chars-to-tokens ratio from the call's usage.
 */

import type { RequestCompositionPartInput } from "../types";

/** One tool declaration as the harness sends it. */
export interface HookTool {
  name: string;
  description: string;
  schema: unknown;
}

/** Which bucket a tool's schema counts under, e.g. `mcp:agent-swarm`. */
export type HookToolGroup = { id: string; label: string };

/** The measured parts of one request. */
export interface HookRequestMeasure {
  /** Changes only when the system prompt or the tool set changes. */
  hash: string;
  /** Tool-schema groups plus the skills listing, all `exact`. */
  parts: RequestCompositionPartInput[];
  /** Chars of the system prompt as sent, skills listing included. */
  systemChars: number;
  /** Chars of the whole request: system, tools and messages. */
  payloadChars: number;
  /** Text chars of the request's messages. */
  messageChars: number;
}

/** Body of the `harness-hook` manifest POST. */
export interface HookCompositionBody {
  sessionId: string;
  provider: string;
  model?: string;
  source: "harness-hook";
  toolLoading: "none";
  parts: RequestCompositionPartInput[];
  harness: {
    systemChars: number;
    payloadChars: number;
    promptTokens: number;
    /** First manifest only: the messages are the task prompt plus harness context. */
    firstMessageChars?: number;
  };
}

export const SWARM_TOOL_GROUP: HookToolGroup = {
  id: "mcp:agent-swarm",
  label: "swarm tool schemas",
};
export const BUILTIN_TOOL_GROUP: HookToolGroup = {
  id: "harness:builtin",
  label: "harness built-in tool schemas",
};

/** Pi's skills block inside its system prompt (native skill discovery). */
const SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/;

/**
 * Keys whose string values are not prompt text: ids, enum tags and binary
 * payloads (image data, thinking signatures) that the provider bills by other
 * rules than chars.
 */
const NON_TEXT_KEYS = new Set([
  "type",
  "role",
  "id",
  "call_id",
  "tool_use_id",
  "toolCallId",
  "cache_control",
  "signature",
  "data",
  "media_type",
  "mime_type",
  "mimeType",
]);

/** Chars of the prompt text inside a message structure. */
export function textChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textChars(item), 0);
  if (value && typeof value === "object") {
    let sum = 0;
    for (const [key, item] of Object.entries(value)) {
      if (!NON_TEXT_KEYS.has(key)) sum += textChars(item);
    }
    return sum;
  }
  return 0;
}

/** Chars of a tool declaration, sized like the server's estimate. */
export function toolChars(tool: HookTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  }).length;
}

/**
 * Measure one request. `system` is the system prompt text as sent, `tools`
 * the declared tools and `messageChars` the text chars of the conversation.
 */
export function measureHookRequest(input: {
  system: string;
  tools: readonly HookTool[];
  messageChars: number;
  groupOf: (toolName: string) => HookToolGroup;
}): HookRequestMeasure {
  const groups = new Map<string, { group: HookToolGroup; chars: number; count: number }>();
  let toolTotal = 0;
  const toolKeys: string[] = [];
  for (const tool of input.tools) {
    const group = input.groupOf(tool.name);
    const chars = toolChars(tool);
    toolTotal += chars;
    toolKeys.push(`${tool.name}\u0000${chars}`);
    const entry = groups.get(group.id) ?? { group, chars: 0, count: 0 };
    entry.chars += chars;
    entry.count++;
    groups.set(group.id, entry);
  }

  const parts: RequestCompositionPartInput[] = [];
  for (const { group, chars, count } of groups.values()) {
    parts.push({
      kind: "tool_schemas",
      id: group.id,
      label: `${group.label} (${count})`,
      chars,
      fidelity: "exact",
    });
  }
  const skills = input.system.match(SKILLS_BLOCK)?.[0];
  if (skills) {
    parts.push({
      kind: "skills_listing",
      id: "harness:skills",
      label: "skills listing",
      chars: skills.length,
      fidelity: "exact",
    });
  }

  return {
    hash: Bun.hash(`${input.system}\u0002${toolKeys.sort().join("\u0001")}`).toString(36),
    parts,
    systemChars: input.system.length,
    payloadChars: input.system.length + toolTotal + input.messageChars,
    messageChars: input.messageChars,
  };
}

/**
 * Posts a manifest once per distinct request shape. A new system prompt or
 * tool set makes the next request pending; the first usage that follows it
 * supplies the call's prompt tokens for calibration, then the manifest posts.
 * A request that never gets usage (a failed call) posts nothing.
 */
export class HookCompositionReporter {
  private lastHash: string | undefined;
  private pending: HookRequestMeasure | undefined;
  private posted = false;

  constructor(
    private readonly meta: { sessionId: string; provider: string },
    private readonly post: (body: HookCompositionBody) => void,
  ) {}

  observeRequest(measure: HookRequestMeasure): void {
    if (measure.hash === this.lastHash) return;
    this.lastHash = measure.hash;
    this.pending = measure;
  }

  /** `promptTokens` = input + cache read + cache write of the call. */
  observeUsage(promptTokens: number, model?: string): void {
    const measure = this.pending;
    if (!measure || !(promptTokens > 0)) return;
    this.pending = undefined;
    const first = !this.posted;
    this.posted = true;
    this.post({
      sessionId: this.meta.sessionId,
      provider: this.meta.provider,
      ...(model ? { model } : {}),
      source: "harness-hook",
      toolLoading: "none",
      parts: measure.parts,
      harness: {
        systemChars: measure.systemChars,
        payloadChars: measure.payloadChars,
        promptTokens: Math.round(promptTokens),
        ...(first ? { firstMessageChars: measure.messageChars } : {}),
      },
    });
  }
}

/** POST a hook manifest. Fire and forget: a lost manifest never fails a session. */
export function postHookComposition(
  config: { apiUrl: string; taskId: string; headers: Record<string, string> },
  body: HookCompositionBody,
): void {
  void fetch(`${config.apiUrl}/api/tasks/${config.taskId}/request-composition`, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(body),
  })
    .then((response) => {
      if (!response.ok) {
        console.warn(`[request-composition] Hook manifest POST returned ${response.status}`);
      }
    })
    .catch(() => {});
}

// ─── Provider payload shapes (pi) ────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SYSTEM_ROLES = new Set(["system", "developer"]);

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(systemText).join("\n");
  if (isObj(value)) {
    if (typeof value.text === "string") return value.text;
    if ("parts" in value) return systemText(value.parts);
    if ("content" in value) return systemText(value.content);
  }
  return "";
}

function payloadTools(raw: unknown): HookTool[] {
  if (!Array.isArray(raw)) return [];
  const tools: HookTool[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    // Google groups declarations under one tool entry.
    if (Array.isArray(entry.functionDeclarations)) {
      tools.push(...payloadTools(entry.functionDeclarations));
      continue;
    }
    const fn = isObj(entry.function) ? entry.function : entry;
    if (typeof fn.name !== "string") continue;
    tools.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      schema: fn.input_schema ?? fn.parameters ?? fn.inputSchema ?? null,
    });
  }
  return tools;
}

/**
 * Split a provider request body into system text, tools and message chars.
 * Covers the shapes pi sends: Anthropic Messages (`system`, `messages`),
 * OpenAI Chat (`messages` with system/developer roles), OpenAI Responses
 * (`instructions`, `input`) and Google (`systemInstruction`, `contents`).
 */
export function splitProviderPayload(payload: unknown): {
  system: string;
  tools: HookTool[];
  messageChars: number;
} {
  if (!isObj(payload)) return { system: "", tools: [], messageChars: 0 };
  const config = isObj(payload.config) ? payload.config : {};
  const systems: string[] = [];
  for (const value of [
    payload.system,
    payload.instructions,
    payload.systemInstruction,
    config.systemInstruction,
  ]) {
    const text = systemText(value);
    if (text) systems.push(text);
  }

  let messageChars = 0;
  for (const list of [payload.messages, payload.input, payload.contents]) {
    if (typeof list === "string") {
      messageChars += list.length;
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (isObj(message) && typeof message.role === "string" && SYSTEM_ROLES.has(message.role)) {
        systems.push(systemText(message.content));
      } else {
        messageChars += textChars(message);
      }
    }
  }

  return {
    system: systems.join("\n"),
    tools: [...payloadTools(payload.tools), ...payloadTools(config.tools)],
    messageChars,
  };
}
