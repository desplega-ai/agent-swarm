/**
 * CLAUDE.md managed-block helper.
 *
 * claude-agent-acp reads `CLAUDE.md` from the session cwd at startup and uses
 * its contents as the agent's project instructions. To inject our per-session
 * `config.systemPrompt` without overwriting any existing repo guidance, we
 * manage a delimited block:
 *
 *   <swarm_system_prompt>
 *   ...our prompt...
 *   </swarm_system_prompt>
 *
 * Rules:
 * - No existing `CLAUDE.md`:
 *     - Write just the block.
 *     - Mark `createdFresh: true` so cleanup removes the file entirely.
 * - Existing `CLAUDE.md` already contains the block: replace it with fresh
 *   contents.
 * - Existing `CLAUDE.md` without the block: prepend the block so the agent
 *   sees our prompt first, then the repo's existing instructions.
 *
 * Cleanup mirrors the creation logic — if we created the file fresh, delete
 * it; otherwise re-read the current CLAUDE.md and strip just the managed
 * block so anything the agent appended during the session is preserved.
 *
 * The helper is deliberately isolated from the adapter so it can be
 * unit-tested without pulling in the claude-agent-acp SDK.
 */

import { join } from "node:path";

const BLOCK_OPEN = "<swarm_system_prompt>";
const BLOCK_CLOSE = "</swarm_system_prompt>";
const BLOCK_REGEX = /<swarm_system_prompt>[\s\S]*?<\/swarm_system_prompt>\n?/;

export interface ClaudeMdHandle {
  cleanup(): Promise<void>;
}

const NOOP_HANDLE: ClaudeMdHandle = {
  cleanup: async () => {},
};

/**
 * Write (or refresh) a managed `<swarm_system_prompt>` block inside
 * `${cwd}/CLAUDE.md`. Returns a handle whose `cleanup()` reverses the edit.
 *
 * No-ops gracefully when `cwd` or `systemPrompt` is falsy.
 */
export async function writeClaudeMd(
  cwd: string | undefined,
  systemPrompt: string | undefined,
): Promise<ClaudeMdHandle> {
  if (!cwd || !systemPrompt) {
    return NOOP_HANDLE;
  }

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const block = `${BLOCK_OPEN}\n${systemPrompt}\n${BLOCK_CLOSE}`;

  const claudeMdFile = Bun.file(claudeMdPath);
  const existingClaudeMdExists = await claudeMdFile.exists();

  let createdFresh = false;
  let newContent: string;

  if (!existingClaudeMdExists) {
    newContent = `${block}\n`;
    createdFresh = true;
  } else {
    const existingContent = await claudeMdFile.text();
    if (BLOCK_REGEX.test(existingContent)) {
      // Replace the stale block in place.
      newContent = existingContent.replace(BLOCK_REGEX, `${block}\n`);
    } else {
      // Prepend the block, keeping existing content intact.
      newContent = `${block}\n\n${existingContent}`;
    }
  }

  await Bun.write(claudeMdPath, newContent);

  return {
    async cleanup(): Promise<void> {
      try {
        if (createdFresh) {
          // Best-effort delete — ignore errors so we never throw from finally.
          await Bun.$`rm -f ${claudeMdPath}`.quiet().nothrow();
          return;
        }
        const currentFile = Bun.file(claudeMdPath);
        if (!(await currentFile.exists())) {
          return;
        }
        const currentContent = await currentFile.text();
        const stripped = currentContent.replace(BLOCK_REGEX, "");
        await Bun.write(claudeMdPath, stripped);
      } catch {
        // Cleanup is best-effort; swallow errors so we don't mask the real
        // completion/failure path.
      }
    },
  };
}
