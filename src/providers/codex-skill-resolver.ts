/**
 * Codex slash-command skill resolver.
 *
 * Codex has no native slash-command/skill system, so we mirror the pi-mono
 * pattern by maintaining a `~/.codex/skills/<name>/SKILL.md` tree and
 * rewriting the turn prompt in the adapter before it reaches
 * `thread.runStreamed()`.
 *
 * If the very first line of the prompt is a slash command like
 * `/work-on-task abc-123`, we look up `${skillsDir}/work-on-task/SKILL.md`
 * and (if found) inline its contents at the top of the new prompt, with the
 * rest of the original prompt (trailing args on the slash line + any
 * subsequent lines) preserved as "User request: …".
 *
 * This helper is intentionally decoupled from the Codex SDK so it can be
 * unit-tested without spinning up a real adapter.
 */

import os from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "./types";

/**
 * Regex matching a leading slash command on a single line.
 *
 * - Must start with `/`
 * - Command name is `[a-z0-9:_-]+` (covers `work-on-task`, `desplega:research`,
 *   `swarm_chat`, …)
 * - Optional trailing args captured greedily in group 2
 */
const SLASH_COMMAND_REGEX = /^\/([a-z0-9:_-]+)(?:\s+(.*))?$/;

const MAX_SKILL_CHARS = Number(process.env.MAX_SKILL_CHARS) || 100_000;

/**
 * Resolve the default skills directory for Codex.
 *
 * Precedence:
 * 1. `CODEX_SKILLS_DIR` env var (useful for tests / custom installs)
 * 2. `${HOME}/.codex/skills` (runtime default in Docker worker + local dev)
 */
function defaultSkillsDir(): string {
  if (process.env.CODEX_SKILLS_DIR) {
    return process.env.CODEX_SKILLS_DIR;
  }
  const home = process.env.HOME ?? os.homedir();
  return join(home, ".codex", "skills");
}

/**
 * Inline a Codex skill into the turn prompt if the first line of the prompt
 * is a recognized slash command and the matching SKILL.md exists on disk.
 *
 * @param prompt - Raw prompt from the runner (may contain a leading slash cmd)
 * @param skillsDir - Absolute path to the skills directory. Defaults to
 *   `${CODEX_SKILLS_DIR ?? ~/.codex/skills}`.
 * @param emit - Optional callback used to surface a `raw_stderr` warning when
 *   the slash command points at a missing SKILL.md. When omitted, warnings
 *   are silently dropped (useful in tests).
 * @returns The rewritten prompt, or the original if there's nothing to do.
 */
export async function resolveCodexPrompt(
  prompt: string,
  skillsDir?: string,
  emit?: (event: ProviderEvent) => void,
): Promise<string> {
  if (!prompt) {
    return prompt;
  }

  // Split on the FIRST newline only; the remainder is preserved verbatim.
  const newlineIdx = prompt.indexOf("\n");
  const firstLineRaw = newlineIdx === -1 ? prompt : prompt.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? "" : prompt.slice(newlineIdx + 1);

  // Detect the slash command on the first line (trimmed — tolerate leading ws).
  const match = SLASH_COMMAND_REGEX.exec(firstLineRaw.trim());
  if (!match || !match[1]) {
    return prompt;
  }

  const commandName: string = match[1];
  const trailingArgs: string = match[2] ?? "";
  const dir = skillsDir ?? defaultSkillsDir();
  const skillPath = join(dir, commandName, "SKILL.md");

  const file = Bun.file(skillPath);
  const exists = await file.exists();
  if (!exists) {
    emit?.({
      type: "raw_stderr",
      content: `[codex] skill resolver: SKILL.md not found for /${commandName} (looked in ${skillPath})\n`,
    });
    return prompt;
  }

  let skillContent: string;
  try {
    skillContent = await file.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit?.({
      type: "raw_stderr",
      content: `[codex] skill resolver: failed to read SKILL.md for /${commandName}: ${message}\n`,
    });
    return prompt;
  }

  if (skillContent.length > MAX_SKILL_CHARS) {
    emit?.({
      type: "raw_stderr",
      content: `[codex] skill resolver: SKILL.md for /${commandName} exceeds ${MAX_SKILL_CHARS} chars (${skillContent.length}), truncating\n`,
    });
    skillContent = skillContent.slice(0, MAX_SKILL_CHARS);
  }

  // Assemble the user-request body: trailing args from the slash line (if any),
  // plus any subsequent lines from the original prompt. Joined with a newline
  // so `/work-on-task foo\n\nproceed` becomes `foo\n\nproceed`.
  const userRequestBody = trailingArgs && rest ? `${trailingArgs}\n${rest}` : trailingArgs || rest;

  return `${skillContent}\n\n---\n\nUser request: ${userRequestBody}`;
}
