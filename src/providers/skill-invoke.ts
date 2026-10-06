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

export type SkillInvokeVia = "tool" | "prompt" | "read";

export interface SkillInvoke {
  via: SkillInvokeVia;
  skillName?: string;
  skillId?: string;
}

/**
 * `Skill`, `skill`, `skill-get`, `skill_get`, and the same names behind an
 * MCP prefix (`mcp__agent-swarm__skill-get`, opencode's `swarm_skill-get`,
 * `agent-swarm.skill-get`). Sibling tools such as `skill-get-file` or
 * `skill-list` do not load a skill and do not match.
 */
const SKILL_TOOL_REGEX = /(?:^|__|[_.])skill(?:[-_]get)?$/i;

/** SKILL.md under a harness's installed-skills directory, e.g. `~/.pi/agent/skills/<name>/SKILL.md`. */
const INSTALLED_SKILL_FILE_REGEX =
  /\/\.(?:pi\/agent|agents|claude|codex|cursor|opencode|config\/opencode)\/skills\/([^/]+)\/SKILL\.md$/;

export function isSkillToolName(toolName: string): boolean {
  return SKILL_TOOL_REGEX.test(toolName);
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
  if (isSkillToolName(toolName)) {
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
 * Collects prompt-path skills for one session and emits each name once.
 *
 * Adapters resolve the prompt inside `createSession` (claude, cursor, dsh,
 * amp, pi) or on the first turn (codex, opencode), so a skill can arrive
 * before the runner's event buffer exists. Names recorded before `attach`
 * are held and emitted on attach.
 */
export function createPromptSkillRecorder(): {
  record: (skillName: string) => void;
  attach: (emit: (skillName: string) => void) => void;
} {
  const seen: string[] = [];
  let emit: ((skillName: string) => void) | undefined;
  return {
    record(skillName) {
      if (seen.includes(skillName)) return;
      seen.push(skillName);
      emit?.(skillName);
    },
    attach(fn) {
      emit = fn;
      for (const skillName of seen) fn(skillName);
    },
  };
}
