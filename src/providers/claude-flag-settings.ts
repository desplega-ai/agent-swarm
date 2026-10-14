import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * The runner writes the agent's `claudeMd` to `/workspace/CLAUDE.md` for the
 * non-Claude harnesses (codex/opencode/pi read and edit it there). Claude Code
 * already gets the same content as user memory from `~/.claude/CLAUDE.md`,
 * and it walks up from its cwd (`/workspace/...`) to load `/workspace/CLAUDE.md`
 * as project memory too, so every Claude session paid for the notes twice.
 *
 * `claudeMdExcludes` drops only that one path from Claude's memory load. The
 * file stays on disk for the other harnesses (one container can live-swap
 * providers mid-run), and repo-level `CLAUDE.md` files still load.
 */
export const WORKSPACE_CLAUDE_MD_EXCLUDE = "/workspace/CLAUDE.md";

export type ClaudeFlagSettings = Record<string, unknown> & { claudeMdExcludes: string[] };

/** Flag-level settings (`--settings` / SDK `settings`) for every Claude session. */
export function claudeFlagSettings(): ClaudeFlagSettings {
  return { claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE] };
}

const SETTINGS_FLAG = "--settings";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one caller `--settings` value the way Claude Code reads it: inline
 * JSON when it starts with `{`, otherwise a settings file path (relative paths
 * resolve against the session cwd). Returns null and logs a scrubbed warning
 * when the value cannot be used; the warning never echoes the JSON itself.
 */
function parseCallerSettings(value: string, cwd: string): Record<string, unknown> | null {
  const inline = value.trimStart().startsWith("{");
  const source = inline ? "inline JSON" : `file ${resolve(cwd, value)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline ? value : readFileSync(resolve(cwd, value), "utf8"));
  } catch (err) {
    const reason = inline ? "invalid JSON" : String((err as NodeJS.ErrnoException).code ?? err);
    console.warn(
      `[claude] ${scrubSecrets(`Ignoring caller --settings (${source}): ${reason}. The workspace CLAUDE.md exclusion still applies.`)}`,
    );
    return null;
  }
  if (!isPlainObject(parsed)) {
    console.warn(
      `[claude] ${scrubSecrets(`Ignoring caller --settings (${source}): not a JSON object. The workspace CLAUDE.md exclusion still applies.`)}`,
    );
    return null;
  }
  return parsed;
}

/**
 * Removes every `--settings <v>` / `--settings=<v>` from each caller argv list
 * (CLAUDE_BINARY prefix args, additionalArgs) and folds those values into the
 * session's own flag settings, so the spawned Claude sees exactly one settings
 * value. Caller keys are kept (later values win); `claudeMdExcludes` becomes
 * the deduped union of the caller lists and the workspace exclusion. An
 * unusable value is dropped with a warning; the exclusion always survives.
 */
export function mergeClaudeSettingsArgs(
  argLists: readonly (readonly string[])[],
  cwd: string,
): { argLists: string[][]; settings: ClaudeFlagSettings } {
  const merged: Record<string, unknown> = {};
  const excludes = new Set<string>();

  const absorb = (value: string | undefined) => {
    if (value === undefined) {
      console.warn("[claude] Ignoring caller --settings with no value.");
      return;
    }
    const parsed = parseCallerSettings(value, cwd);
    if (!parsed) return;
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
        absorb(args[i + 1]);
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
