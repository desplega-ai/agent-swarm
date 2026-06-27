/**
 * Codex AGENTS.md helper.
 *
 * Codex reads `AGENTS.md` from the session cwd at startup and uses its contents
 * as the agent's base instructions. There is no `ThreadStartParams.systemPrompt`
 * / `developerInstructions` equivalent wired through the SDK 0.118 public
 * surface, so the only way to inject our per-session `config.systemPrompt` is
 * to write it into `AGENTS.md` before `thread.runStreamed()` is called.
 *
 * To avoid stomping on any existing `AGENTS.md` content (or any `CLAUDE.md`
 * that the repo already ships with), we manage a delimited block:
 *
 *   <swarm_system_prompt>
 *   ...our prompt...
 *   </swarm_system_prompt>
 *
 * Rules:
 * - No existing `AGENTS.md`:
 *     - If `CLAUDE.md` exists in cwd, prepend the block to the CLAUDE.md
 *       contents so Codex sees our prompt plus the repo's existing Claude
 *       instructions.
 *     - Otherwise, write just the block.
 *     - Mark `createdFresh: true` so cleanup removes the file entirely.
 * - Existing `AGENTS.md` already contains the block: replace the block with
 *   the fresh contents.
 * - Existing `AGENTS.md` without the block: prepend the block.
 *
 * Cleanup mirrors the creation logic — if we created the file fresh, delete
 * it; otherwise re-read the current AGENTS.md and strip just the managed
 * block so anything the agent appended during the session is preserved.
 *
 * The helper is deliberately isolated from the adapter so it can be
 * unit-tested without pulling in the Codex SDK.
 */

import { join } from "node:path";

const BLOCK_OPEN = "<swarm_system_prompt>";
const BLOCK_CLOSE = "</swarm_system_prompt>";
const BLOCK_REGEX = /<swarm_system_prompt>[\s\S]*?<\/swarm_system_prompt>\n?/;

export interface CodexAgentsMdHandle {
  cleanup(): Promise<void>;
}

const NOOP_HANDLE: CodexAgentsMdHandle = {
  cleanup: async () => {},
};

/**
 * Write (or refresh) a managed `<swarm_system_prompt>` block inside
 * `${cwd}/AGENTS.md`. Returns a handle whose `cleanup()` reverses the edit.
 *
 * No-ops gracefully when `cwd` or `systemPrompt` is falsy.
 */
export async function writeCodexAgentsMd(
  cwd: string | undefined,
  systemPrompt: string | undefined,
): Promise<CodexAgentsMdHandle> {
  if (!cwd || !systemPrompt) {
    return NOOP_HANDLE;
  }

  const agentsMdPath = join(cwd, "AGENTS.md");
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const block = `${BLOCK_OPEN}\n${systemPrompt}\n${BLOCK_CLOSE}`;

  const agentsMdFile = Bun.file(agentsMdPath);
  const existingAgentsMdExists = await agentsMdFile.exists();

  let createdFresh = false;
  let newContent: string;

  if (!existingAgentsMdExists) {
    // No AGENTS.md yet — prefer CLAUDE.md content as a base if present.
    const claudeMdFile = Bun.file(claudeMdPath);
    const claudeMdExists = await claudeMdFile.exists();
    if (claudeMdExists) {
      const claudeContent = await claudeMdFile.text();
      newContent = `${block}\n\n${claudeContent}`;
    } else {
      newContent = `${block}\n`;
    }
    createdFresh = true;
  } else {
    const existingContent = await agentsMdFile.text();
    if (BLOCK_REGEX.test(existingContent)) {
      // Replace the stale block in place.
      newContent = existingContent.replace(BLOCK_REGEX, `${block}\n`);
    } else {
      // Prepend the block, keeping existing content intact.
      newContent = `${block}\n\n${existingContent}`;
    }
  }

  await Bun.write(agentsMdPath, newContent);

  return {
    async cleanup(): Promise<void> {
      try {
        if (createdFresh) {
          // Best-effort delete — ignore errors so we never throw from finally.
          await Bun.$`rm -f ${agentsMdPath}`.quiet().nothrow();
          return;
        }
        const currentFile = Bun.file(agentsMdPath);
        if (!(await currentFile.exists())) {
          return;
        }
        const currentContent = await currentFile.text();
        const stripped = currentContent.replace(BLOCK_REGEX, "");
        await Bun.write(agentsMdPath, stripped);
      } catch {
        // Cleanup is best-effort; swallow errors so we don't mask the real
        // completion/failure path.
      }
    },
  };
}
