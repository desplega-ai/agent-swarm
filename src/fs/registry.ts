import { AgentFsProvider } from "./agent-fs-provider";
import { LocalFsProvider } from "./local-fs-provider";
import type { FileStorageProvider } from "./provider";

let memoizedProvider: FileStorageProvider | null = null;

export function getFileStorageProvider(): FileStorageProvider {
  if (!memoizedProvider) {
    memoizedProvider = selectProvider();
  }
  return memoizedProvider;
}

export function selectProvider(): FileStorageProvider {
  if (
    process.env.AGENT_FS_API_URL &&
    (process.env.API_AGENT_FS_API_KEY || process.env.AGENT_FS_API_KEY)
  ) {
    return new AgentFsProvider();
  }
  return new LocalFsProvider();
}

/**
 * Drop the memoized provider so the next `getFileStorageProvider()` re-runs
 * selection against current `process.env`. Needed by the config reload path:
 * agent-fs provisioning can land AFTER the first fs request memoized
 * `local-fs` (e.g. cloud swarms where the boot seeder had no
 * AGENT_FS_API_URL yet), and without a reset the process is stuck on the
 * wrong provider until restart.
 */
export function resetFileStorageProvider(): void {
  memoizedProvider = null;
}

export function resetFileStorageProviderForTests(): void {
  resetFileStorageProvider();
}
