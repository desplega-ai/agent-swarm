/** Recover AGENTS.md changes left by sessions from before native instructions. */
import { lstat, realpath, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const BLOCK_REGEX = /<swarm_system_prompt>[\s\S]*?<\/swarm_system_prompt>\n?/;
const STATE_DIR = join(homedir(), ".cache", "agent-swarm", "codex-agents-md");

/**
 * Strip a legacy prompt block and restore a swapped symlink from the old
 * out-of-repo recovery record. New sessions never create blocks or records.
 */
export async function recoverLegacyCodexAgentsMd(cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const agentsMdPath = join(realCwd, "AGENTS.md");
  const key = new Bun.CryptoHasher("sha256").update(realCwd).digest("hex");
  const recordPath = join(STATE_DIR, `${key}.json`);
  const record = (await Bun.file(recordPath)
    .json()
    .catch(() => null)) as { cwd?: unknown; linkTarget?: unknown } | null;
  const linkTarget =
    record?.cwd === realCwd && typeof record.linkTarget === "string" ? record.linkTarget : null;
  const stat = await lstat(agentsMdPath).catch(() => null);
  const current = stat?.isFile() ? await Bun.file(agentsMdPath).text() : null;
  const stripped = current === null ? null : current.replace(BLOCK_REGEX, "");

  if (linkTarget !== null && (!stat || (stripped !== null && stripped !== current))) {
    // Carry edits back before removing the recovery copy, so a failed write
    // leaves both the copy and the record available for the next attempt.
    if (stripped !== null) {
      const target = await realpath(resolve(realCwd, linkTarget)).catch(() => null);
      const prefix = realCwd.endsWith(sep) ? realCwd : `${realCwd}${sep}`;
      if (target !== null && target !== agentsMdPath && target.startsWith(prefix)) {
        const targetStat = await lstat(target);
        if (targetStat.isFile() && stripped !== (await Bun.file(target).text())) {
          await Bun.write(target, stripped);
        }
      }
    }
    if (stat) await unlink(agentsMdPath);
    await symlink(linkTarget, agentsMdPath);
  } else if (stripped !== null && stripped !== current) {
    await Bun.write(agentsMdPath, stripped);
  }

  if (linkTarget !== null) await unlink(recordPath);
}
