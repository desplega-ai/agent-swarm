import { AgentFsProvider } from "../fs/agent-fs-provider";
import { getFileStorageProvider } from "../fs/registry";

/**
 * The agent-fs provider (the swarm's bootstrap key) that Comb uses to read
 * comments and post the "sent" replies. Null when the swarm has no agent-fs
 * provider yet (no key, or the shared drive is not provisioned).
 */
export function combAgentFs(): AgentFsProvider | null {
  try {
    const provider = getFileStorageProvider();
    return provider instanceof AgentFsProvider ? provider : null;
  } catch {
    return null;
  }
}

// `/status` waits this long for the first lookup. Later calls read the cache.
const STATUS_LOOKUP_WAIT_MS = 2_000;

/**
 * The agent-fs user id of the swarm service account, for `/status`
 * (`agent_fs.comb.service_user_id`). The dashboard trusts a "sent" reply only
 * from this author. Null when agent-fs is not set up, the lookup fails, or it
 * takes longer than `STATUS_LOOKUP_WAIT_MS` (the next poll reads the cache).
 */
export async function getCombServiceUserId(): Promise<string | null> {
  const agentFs = combAgentFs();
  if (!agentFs) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, STATUS_LOOKUP_WAIT_MS, null);
  });
  try {
    return await Promise.race([agentFs.getServiceUserId().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
