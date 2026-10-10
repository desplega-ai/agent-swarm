/**
 * Harness-neutral detection for `skill.invoke` telemetry.
 *
 * A skill reaches a session one of three ways, recorded as `data.via`:
 * - `"tool"`: a skill-loading tool call. Claude Code's `Skill`, the native
 *   `skill` tool of opencode and amp, and the swarm `skill-get` MCP tool under
 *   whatever prefix the harness gives MCP tools.
 * - `"prompt"`: a leading `/name` the adapter inlined
 *   (`resolveSlashSkillPrompt`), or pi expanded natively (`/skill:name`). No
 *   tool call happens on this path, on any harness.
 * - `"read"`: the model read an installed SKILL.md itself. Pi lists its skills
 *   in the system prompt and tells the model to load them with `read`.
 *
 * Pure helpers, so worker-side code can use them without touching the DB.
 */

import type { ProviderEvent } from "./types";

export type SkillInvokeVia = "tool" | "prompt" | "read";

export interface SkillInvoke {
  via: SkillInvokeVia;
  skillName?: string;
  skillId?: string;
}

/** Native skill tools: Claude Code's `Skill`, opencode's and amp's `skill`. */
const NATIVE_SKILL_TOOLS = new Set(["Skill", "skill"]);

/** Names the swarm MCP server goes by: `agent-swarm`, amp's `agent_swarm`, opencode's `swarm`. */
const SWARM_MCP_SERVERS = new Set(["agent-swarm", "agent_swarm", "swarm"]);

/** The swarm tool that loads a skill. Siblings (`skill-get-file`, `skill-list`) load none. */
const SWARM_SKILL_TOOLS = new Set(["skill-get", "skill_get"]);

/** SKILL.md under a harness's installed-skills directory, e.g. `~/.pi/agent/skills/<name>/SKILL.md`. */
const INSTALLED_SKILL_FILE_REGEX =
  /\/\.(?:pi\/agent|agents|claude|codex|cursor|opencode|config\/opencode)\/skills\/([^/]+)\/SKILL\.md$/;

/**
 * Splits an MCP tool name into server and tool: `mcp__<server>__<tool>`
 * (claude, cursor, dsh), `<server>.<tool>` or `<server>:<tool>`, and
 * opencode's `<server>_<tool>`. A bare name is a pi swarm tool, which pi
 * registers unprefixed, so it gets no server.
 */
function splitToolName(toolName: string): { server?: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return { server: mcp[1], tool: mcp[2] as string };
  const separated = /^(.+?)[.:](.+)$/.exec(toolName);
  if (separated) return { server: separated[1], tool: separated[2] as string };
  for (const server of SWARM_MCP_SERVERS) {
    if (toolName.startsWith(`${server}_`))
      return { server, tool: toolName.slice(server.length + 1) };
  }
  return { tool: toolName };
}

/**
 * True when a call loads a skill: a native skill tool, or the swarm MCP
 * server's `skill-get`. A same-named tool from any other MCP server does not
 * count. Codex reports MCP calls by bare tool name and keeps the server in
 * its `{ server, tool, arguments }` args, so that envelope decides for it.
 */
export function isSkillLoaderCall(toolName: string, args: unknown): boolean {
  const a = argsRecord(args);
  if (a && typeof a.server === "string" && typeof a.tool === "string") {
    return SWARM_MCP_SERVERS.has(a.server) && SWARM_SKILL_TOOLS.has(a.tool);
  }
  if (NATIVE_SKILL_TOOLS.has(toolName)) return true;
  const { server, tool } = splitToolName(toolName);
  return SWARM_SKILL_TOOLS.has(tool) && (server === undefined || SWARM_MCP_SERVERS.has(server));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function argsRecord(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") {
    try {
      return argsRecord(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  return args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
}

/**
 * The skill a skill-loading tool call names. Claude's `Skill` takes `skill`;
 * opencode's and amp's `skill` and the swarm `skill-get` take `name`
 * (`skill-get` also accepts `skillId`). Codex reports MCP calls as
 * `{ server, tool, arguments }`, so the arguments sit one level down.
 */
export function skillFromToolArgs(args: unknown): { skillName?: string; skillId?: string } {
  const a = argsRecord(args);
  if (!a) return {};
  if ("arguments" in a && typeof a.tool === "string") return skillFromToolArgs(a.arguments);
  const skillName =
    nonEmptyString(a.skill) ?? nonEmptyString(a.name) ?? nonEmptyString(a.skillName);
  const skillId = nonEmptyString(a.skillId);
  return { ...(skillName ? { skillName } : {}), ...(skillId ? { skillId } : {}) };
}

/** The `skill.invoke` a `tool_start` represents, or null when the tool loads no skill. */
export function skillInvokeFromToolStart(toolName: string, args: unknown): SkillInvoke | null {
  if (isSkillLoaderCall(toolName, args)) {
    return { via: "tool", ...skillFromToolArgs(args) };
  }
  if (toolName === "Read" || toolName === "read") {
    const a = argsRecord(args);
    const path = nonEmptyString(a?.file_path) ?? nonEmptyString(a?.path);
    const skillName = path ? INSTALLED_SKILL_FILE_REGEX.exec(path)?.[1] : undefined;
    if (skillName) return { via: "read", skillName };
  }
  return null;
}

/**
 * The skill pi expands from a `/skill:name` prompt, mirroring pi's
 * `AgentSession._expandSkillCommand`: the prompt must start with `/skill:`,
 * the name runs to the first space, and an unknown name passes through.
 */
export function piPromptSkillName(
  prompt: string,
  installedSkillNames: readonly string[],
): string | undefined {
  if (!prompt.startsWith("/skill:")) return undefined;
  const spaceIndex = prompt.indexOf(" ");
  const name = spaceIndex === -1 ? prompt.slice(7) : prompt.slice(7, spaceIndex);
  return installedSkillNames.includes(name) ? name : undefined;
}

/**
 * Session-level `skill.invoke` recorder shared by all three paths.
 *
 * - Each skill is emitted once per session, whichever path delivers it first.
 *   A `/work-on-task` prompt followed by `skill-get({ name: "work-on-task" })`
 *   is one row. A call that names both a skill and its id claims both keys.
 * - A read of SKILL.md counts only once its `tool_end` reports success; the
 *   candidate waits under its `toolCallId` until then. A harness that emits no
 *   `tool_end` (Claude Code) records no read-path skills.
 * - Adapters resolve the prompt inside `createSession` (claude, cursor, dsh,
 *   amp, pi) or on the first turn (codex, opencode), so a skill can arrive
 *   before the runner's event buffer exists. Invocations recorded before
 *   `attach` are held and emitted on attach.
 */
export function createSkillInvokeTracker(): {
  promptSkill: (skillName: string) => void;
  onEvent: (event: ProviderEvent) => void;
  attach: (emit: (invoke: SkillInvoke) => void) => void;
} {
  const seenKeys = new Set<string>();
  const held: SkillInvoke[] = [];
  const pendingReads = new Map<string, SkillInvoke>();
  let emit: ((invoke: SkillInvoke) => void) | undefined;

  function record(invoke: SkillInvoke) {
    const keys = [
      ...(invoke.skillName ? [`name:${invoke.skillName}`] : []),
      ...(invoke.skillId ? [`id:${invoke.skillId}`] : []),
    ];
    if (keys.some((key) => seenKeys.has(key))) return;
    for (const key of keys) seenKeys.add(key);
    if (emit) emit(invoke);
    else held.push(invoke);
  }

  return {
    promptSkill: (skillName) => record({ via: "prompt", skillName }),
    onEvent(event) {
      if (event.type === "tool_start") {
        const invoke = skillInvokeFromToolStart(event.toolName, event.args);
        if (invoke?.via === "read") pendingReads.set(event.toolCallId, invoke);
        else if (invoke) record(invoke);
      } else if (event.type === "tool_end") {
        const invoke = pendingReads.get(event.toolCallId);
        if (!invoke) return;
        pendingReads.delete(event.toolCallId);
        if (!event.isError) record(invoke);
      }
    },
    attach(fn) {
      emit = fn;
      for (const invoke of held.splice(0)) fn(invoke);
    },
  };
}
