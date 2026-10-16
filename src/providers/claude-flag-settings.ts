import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * The runner writes the agent's `claudeMd` to `/workspace/CLAUDE.md` for the
 * non-Claude harnesses (codex/opencode/pi read and edit it there). Claude Code
 * already gets the same content as user memory from `~/.claude/CLAUDE.md`,
 * and it walks up from its cwd (`/workspace/...`) to load `/workspace/CLAUDE.md`
 * as project memory too, so every Claude session paid for the notes twice.
 *
 * `claudeMdExcludes` drops that path from Claude's memory load. The file stays
 * on disk for the other harnesses (one container can live-swap providers
 * mid-run), and repo-level `CLAUDE.md` files still load.
 *
 * The user-memory copy (`~/.claude/CLAUDE.md`) is excluded too: the system
 * prompt carries the same notes (base-prompt.ts block J), where the provider
 * caches them across sessions. Claude would load the user-memory copy into an
 * uncached message instead. The SessionStart hook still writes that file: it
 * is the copy the agent edits and the Stop hook syncs back to the profile.
 */
export const WORKSPACE_CLAUDE_MD_EXCLUDE = "/workspace/CLAUDE.md";

/** `~/.claude/CLAUDE.md` for the HOME the Claude session runs under. */
export function userClaudeMdExclude(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".claude", "CLAUDE.md");
}

export type ClaudeFlagSettings = Record<string, unknown> & { claudeMdExcludes: string[] };

/** Flag-level settings (`--settings` / SDK `settings`) for every Claude session. */
export function claudeFlagSettings(): ClaudeFlagSettings {
  return { claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE, userClaudeMdExclude()] };
}

const SETTINGS_FLAG = "--settings";

/**
 * Explicit caller `--settings` that cannot be used. The session refuses to
 * start: launching without them would drop the caller's sandbox rules and
 * blocking hooks while still running with bypassPermissions. The message is
 * scrubbed and never echoes inline JSON.
 */
export class ClaudeSettingsConfigError extends Error {
  constructor(detail: string) {
    super(
      scrubSecrets(
        `Invalid caller --settings: ${detail}. Refusing to start Claude without the caller's settings.`,
      ),
    );
    this.name = "ClaudeSettingsConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one caller `--settings` value the way Claude Code reads it: inline
 * JSON when it starts with `{`, otherwise a settings file path (relative paths
 * resolve against the session cwd). Throws ClaudeSettingsConfigError when the
 * value cannot be used.
 */
function parseCallerSettings(value: string, cwd: string): Record<string, unknown> {
  const inline = value.trimStart().startsWith("{");
  const source = inline ? "inline JSON" : `file ${resolve(cwd, value)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline ? value : readFileSync(resolve(cwd, value), "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ClaudeSettingsConfigError(
      `${source} ${inline || !code ? "is not valid JSON" : `cannot be read (${code})`}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsConfigError(`${source} is not a JSON object`);
  }
  return parsed;
}

/**
 * Removes every `--settings <v>` / `--settings=<v>` from each caller argv list
 * (CLAUDE_BINARY prefix args, additionalArgs) and folds those values into the
 * session's own flag settings, so the spawned Claude sees exactly one settings
 * value. Caller keys are kept (later values win); `claudeMdExcludes` becomes
 * the deduped union of the caller lists and the workspace exclusion.
 *
 * Fails closed: a missing value (end of argv, or a next token that is another
 * flag) or an unreadable, invalid or non-object value throws
 * ClaudeSettingsConfigError instead of starting without the caller's settings.
 */
export function mergeClaudeSettingsArgs(
  argLists: readonly (readonly string[])[],
  cwd: string,
): { argLists: string[][]; settings: ClaudeFlagSettings } {
  const merged: Record<string, unknown> = {};
  const excludes = new Set<string>();

  const absorb = (value: string | undefined) => {
    if (!value) throw new ClaudeSettingsConfigError("--settings has no value");
    const parsed = parseCallerSettings(value, cwd);
    Object.assign(merged, parsed);
    if (Array.isArray(parsed.claudeMdExcludes)) {
      for (const entry of parsed.claudeMdExcludes) {
        if (typeof entry === "string") excludes.add(entry);
      }
    }
  };

  const stripped = argLists.map((args) => {
    const passthrough: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === SETTINGS_FLAG) {
        const value = args[i + 1];
        // Never consume the next flag (`--max-turns`, `--settings=...`) as the value.
        absorb(value?.startsWith("-") ? undefined : value);
        i++;
      } else if (arg.startsWith(`${SETTINGS_FLAG}=`)) {
        absorb(arg.slice(SETTINGS_FLAG.length + 1));
      } else {
        passthrough.push(arg);
      }
    }
    return passthrough;
  });

  for (const entry of claudeFlagSettings().claudeMdExcludes) excludes.add(entry);
  return { argLists: stripped, settings: { ...merged, claudeMdExcludes: [...excludes] } };
}
