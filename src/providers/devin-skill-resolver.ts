/**
 * Devin skill resolver.
 *
 * Devin has no native skill system, so we inline SKILL.md content into the
 * prompt before sending it to the Devin API.
 *
 * If the very first line of the prompt matches `@skills:<name> <args>`, we
 * look up `${skillsDir}/<name>/SKILL.md` and (if found) inline its contents
 * at the top of the new prompt, with the rest of the original prompt
 * preserved as "User request: ...".
 *
 * This mirrors the pattern in codex-skill-resolver.ts.
 */

import { join } from "node:path";
import type { ProviderEvent } from "./types";

/**
 * Regex matching a leading `@skills:<name>` on a single line.
 *
 * - Must start with `@skills:`
 * - Skill name is `[a-z0-9:_-]+`
 * - Optional trailing args captured greedily in group 2
 */
const SKILL_COMMAND_REGEX = /^@skills:([a-z0-9:_-]+)(?:\s+(.*))?$/;

const MAX_SKILL_CHARS = Number(process.env.MAX_SKILL_CHARS) || 100_000;

/**
 * Default skills directory — `plugin/pi-skills/` relative to the project root.
 *
 * Precedence:
 * 1. `DEVIN_SKILLS_DIR` env var (useful for tests / custom installs)
 * 2. `<project-root>/plugin/pi-skills`
 */
function defaultSkillsDir(): string {
  if (process.env.DEVIN_SKILLS_DIR) {
    return process.env.DEVIN_SKILLS_DIR;
  }
  // import.meta.dir is src/providers/ — go up two levels to project root
  return join(import.meta.dir, "..", "..", "plugin", "pi-skills");
}

/**
 * Inline a skill into the prompt if the first line matches `@skills:<name>`.
 *
 * @param prompt - Raw prompt from the runner
 * @param skillsDir - Absolute path to the skills directory. Defaults to
 *   `plugin/pi-skills/` in the project root.
 * @param emit - Optional callback to surface warnings via `raw_stderr` events.
 * @returns The rewritten prompt, or the original if there's nothing to inline.
 */
export async function resolveDevinPrompt(
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

  // Detect the @skills: command on the first line (trimmed — tolerate leading ws).
  const match = SKILL_COMMAND_REGEX.exec(firstLineRaw.trim());
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
      content: `[devin] skill resolver: SKILL.md not found for @skills:${commandName} (looked in ${skillPath})\n`,
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
      content: `[devin] skill resolver: failed to read SKILL.md for @skills:${commandName}: ${message}\n`,
    });
    return prompt;
  }

  if (skillContent.length > MAX_SKILL_CHARS) {
    emit?.({
      type: "raw_stderr",
      content: `[devin] skill resolver: SKILL.md for @skills:${commandName} exceeds ${MAX_SKILL_CHARS} chars (${skillContent.length}), truncating\n`,
    });
    skillContent = skillContent.slice(0, MAX_SKILL_CHARS);
  }

  // Assemble the user-request body: trailing args from the @skills: line (if any),
  // plus any subsequent lines from the original prompt.
  const userRequestBody = trailingArgs && rest ? `${trailingArgs}\n${rest}` : trailingArgs || rest;

  return `${skillContent}\n\n---\n\nUser request: ${userRequestBody}`;
}
