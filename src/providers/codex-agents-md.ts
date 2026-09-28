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
 *     link target's contents, and restore the symlink on cleanup. The target is
 *     only read, and edits only carried back to it, when its real path is a
 *     regular file inside the cwd. A crash-recovery record (cwd + link target)
 *     is kept OUTSIDE the repo, so the next session can restore the link if
 *     this one crashed before cleanup. Repo content never names a path.
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

import { lstat, mkdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const BLOCK_OPEN = "<swarm_system_prompt>";
const BLOCK_CLOSE = "</swarm_system_prompt>";
const BLOCK_REGEX = /<swarm_system_prompt>[\s\S]*?<\/swarm_system_prompt>\n?/;
const DEFAULT_STATE_DIR = join(homedir(), ".cache", "agent-swarm", "codex-agents-md");

export interface CodexAgentsMdHandle {
  cleanup(): Promise<void>;
}

export interface CodexAgentsMdOptions {
  /** Where symlink crash-recovery records live. Must be outside any repo. */
  stateDir?: string;
}

interface SymlinkRecord {
  cwd: string;
  linkTarget: string;
}

const NOOP_HANDLE: CodexAgentsMdHandle = {
  cleanup: async () => {},
};

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}

function recordPathFor(stateDir: string, realCwd: string): string {
  const key = new Bun.CryptoHasher("sha256").update(realCwd).digest("hex");
  return join(stateDir, `${key}.json`);
}

async function readRecord(recordPath: string, realCwd: string): Promise<SymlinkRecord | null> {
  try {
    const record = JSON.parse(await Bun.file(recordPath).text()) as Partial<SymlinkRecord>;
    if (record.cwd === realCwd && typeof record.linkTarget === "string") {
      return { cwd: record.cwd, linkTarget: record.linkTarget };
    }
  } catch {
    // Missing or unreadable record: nothing to recover.
  }
  return null;
}

/**
 * Real path of the symlink target when it is a regular file inside the cwd,
 * otherwise null. Out-of-tree and dangling targets are never read or written.
 */
async function inTreeTarget(
  realCwd: string,
  agentsMdPath: string,
  linkTarget: string,
): Promise<string | null> {
  const target = await realpath(resolve(dirname(agentsMdPath), linkTarget)).catch(() => null);
  const prefix = realCwd.endsWith(sep) ? realCwd : `${realCwd}${sep}`;
  if (target === null || !target.startsWith(prefix)) {
    return null;
  }
  const stat = await lstat(target).catch(() => null);
  return stat?.isFile() ? target : null;
}

/**
 * Put the `AGENTS.md -> linkTarget` symlink back in place of our swapped-in
 * real file. Edits the agent made to AGENTS.md during the session would have
 * landed in the link target had the link been in place, so carry them over
 * (block stripped) when the target is in-tree and its contents differ.
 */
async function restoreSymlink(
  agentsMdPath: string,
  realCwd: string,
  linkTarget: string,
): Promise<void> {
  const stat = await lstat(agentsMdPath).catch(() => null);
  const current = stat?.isFile() ? await Bun.file(agentsMdPath).text() : null;
  await unlink(agentsMdPath).catch(() => {});
  await symlink(linkTarget, agentsMdPath);
  if (current === null) {
    return;
  }
  const target = await inTreeTarget(realCwd, agentsMdPath, linkTarget);
  if (target === null) {
    return;
  }
  const stripped = current.replace(BLOCK_REGEX, "");
  if (stripped !== (await Bun.file(target).text())) {
    await Bun.write(target, stripped);
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
  options: CodexAgentsMdOptions = {},
): Promise<CodexAgentsMdHandle> {
  if (!cwd || !systemPrompt) {
    return NOOP_HANDLE;
  }

  const agentsMdPath = join(cwd, "AGENTS.md");
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const recordPath = recordPathFor(stateDir, realCwd);
  const block = `${BLOCK_OPEN}\n${systemPrompt}\n${BLOCK_CLOSE}`;

  let stat = await lstat(agentsMdPath).catch(() => null);

  // A previous session swapped a symlink out and crashed before cleanup. Only
  // our own out-of-repo record can trigger a restore, and only while AGENTS.md
  // is still the real file holding our block.
  const record = await readRecord(recordPath, realCwd);
  if (record) {
    if (stat?.isFile() && BLOCK_REGEX.test(await Bun.file(agentsMdPath).text())) {
      await restoreSymlink(agentsMdPath, realCwd, record.linkTarget);
      stat = await lstat(agentsMdPath);
    }
    await unlink(recordPath).catch(() => {});
  }

  if (stat?.isSymbolicLink()) {
    const linkTarget = await readlink(agentsMdPath);
    const target = await inTreeTarget(realCwd, agentsMdPath, linkTarget);
    const targetContent = target !== null ? await Bun.file(target).text() : "";
    // Record before swapping, so a crash at any later point stays recoverable.
    await mkdir(stateDir, { recursive: true });
    await Bun.write(recordPath, JSON.stringify({ cwd: realCwd, linkTarget }));
    // Never write through the link: replace it with a real file for the session.
    await unlink(agentsMdPath);
    await Bun.write(agentsMdPath, `${block}\n${targetContent.replace(BLOCK_REGEX, "")}`);

    return {
      async cleanup(): Promise<void> {
        try {
          await restoreSymlink(agentsMdPath, realCwd, linkTarget);
          await unlink(recordPath).catch(() => {});
        } catch {
          // Cleanup is best-effort; the record lets the next session finish
          // the restore.
        }
      },
    };
  }

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
