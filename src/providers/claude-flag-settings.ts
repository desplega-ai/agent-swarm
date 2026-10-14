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

/** Flag-level settings (`--settings` / SDK `settings`) for every Claude session. */
export function claudeFlagSettings(): { claudeMdExcludes: string[] } {
  return { claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE] };
}
