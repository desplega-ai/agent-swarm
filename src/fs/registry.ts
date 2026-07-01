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

export function resetFileStorageProviderForTests(): void {
  memoizedProvider = null;
}
