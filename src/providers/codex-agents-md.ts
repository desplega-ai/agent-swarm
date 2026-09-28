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
 * - `AGENTS.md` is a symlink (many repos ship `AGENTS.md -> CLAUDE.md`):
 *     never write through it. Swap in a real file holding the block plus the
 *     link target's contents, and restore the symlink on cleanup. The open tag
 *     records the link target (`<swarm_system_prompt symlink="...">`) so the
 *     next session can restore the link if this one crashed before cleanup.
 * - Existing `AGENTS.md` already contains the block: replace the block with
 *   the fresh contents.
 * - Existing `AGENTS.md` without the block: prepend the block.
 *
 * Cleanup mirrors the creation logic — if we created the file fresh, delete
 * it; if we swapped out a symlink, restore it; otherwise re-read the current
 * AGENTS.md and strip just the managed block so anything the agent appended
 * during the session is preserved.
 *
 * The helper is deliberately isolated from the adapter so it can be
 * unit-tested without pulling in the Codex SDK.
 */

import { lstat, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const BLOCK_OPEN = "<swarm_system_prompt>";
const BLOCK_CLOSE = "</swarm_system_prompt>";
const BLOCK_REGEX = /<swarm_system_prompt(?: symlink="[^"]*")?>[\s\S]*?<\/swarm_system_prompt>\n?/;
const SYMLINK_MARKER_REGEX = /<swarm_system_prompt symlink="([^"]*)">/;

export interface CodexAgentsMdHandle {
  cleanup(): Promise<void>;
}

const NOOP_HANDLE: CodexAgentsMdHandle = {
  cleanup: async () => {},
};

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}

/**
 * Put the `AGENTS.md -> linkTarget` symlink back in place of our swapped-in
 * real file. Edits the agent made to AGENTS.md during the session would have
 * landed in the link target had the link been in place, so carry them over
 * (block stripped) when they differ from the target's current contents.
 */
async function restoreSymlink(agentsMdPath: string, linkTarget: string): Promise<void> {
  const current = await readIfExists(agentsMdPath);
  const targetPath = resolve(dirname(agentsMdPath), linkTarget);
  const targetContent = await readIfExists(targetPath);
  await unlink(agentsMdPath).catch(() => {});
  await symlink(linkTarget, agentsMdPath);
  if (current === null || targetContent === null) {
    return;
  }
  const stripped = current.replace(BLOCK_REGEX, "");
  if (stripped !== targetContent) {
    await Bun.write(targetPath, stripped);
  }
}

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

  let stat = await lstat(agentsMdPath).catch(() => null);

  // A previous session swapped a symlink out and crashed before cleanup:
  // restore the link first, then proceed as a normal symlink session.
  if (stat?.isFile()) {
    const marker = (await Bun.file(agentsMdPath).text()).match(SYMLINK_MARKER_REGEX);
    if (marker?.[1] !== undefined) {
      await restoreSymlink(agentsMdPath, decodeURIComponent(marker[1]));
      stat = await lstat(agentsMdPath);
    }
  }

  if (stat?.isSymbolicLink()) {
    const linkTarget = await readlink(agentsMdPath);
    const targetContent = (await readIfExists(resolve(dirname(agentsMdPath), linkTarget))) ?? "";
    const block = `<swarm_system_prompt symlink="${encodeURIComponent(linkTarget)}">\n${systemPrompt}\n${BLOCK_CLOSE}`;
    // Never write through the link: replace it with a real file for the session.
    await unlink(agentsMdPath);
    await Bun.write(agentsMdPath, `${block}\n${targetContent.replace(BLOCK_REGEX, "")}`);

    return {
      async cleanup(): Promise<void> {
        try {
          await restoreSymlink(agentsMdPath, linkTarget);
        } catch {
          // Cleanup is best-effort; the symlink marker lets the next session
          // finish the restore.
        }
      },
    };
  }

  const block = `${BLOCK_OPEN}\n${systemPrompt}\n${BLOCK_CLOSE}`;
  let createdFresh = false;
  let newContent: string;

  if (!stat) {
    // No AGENTS.md yet — prefer CLAUDE.md content as a base if present.
    const claudeContent = await readIfExists(claudeMdPath);
    newContent = claudeContent !== null ? `${block}\n\n${claudeContent}` : `${block}\n`;
    createdFresh = true;
  } else {
    const existingContent = await Bun.file(agentsMdPath).text();
    if (BLOCK_REGEX.test(existingContent)) {
      // Replace the stale block in place.
      newContent = existingContent.replace(BLOCK_REGEX, `${block}\n`);
    } else {
      // Prepend the block with a single newline so cleanup's strip restores
      // the original bytes exactly.
      newContent = `${block}\n${existingContent}`;
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
