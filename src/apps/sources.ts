import { defaultAssetKey } from "../assets/key";
import { agentFsClientFor } from "../be/agent-fs-identity";
import { getStorage } from "../be/storage";

const SOURCE_FILES_LIMIT = 50;
const SOURCE_LIST_BUDGET_MS = 1_000;

/**
 * Where an app's agent-authored sources live: `<app asset key>src/` on
 * agent-fs (generators, backing-script drafts, `NOTES.md`). The server never
 * writes there; it only points at the folder and lists it, best effort.
 */
export async function appSourcesPath(appId: string): Promise<string> {
  const key =
    (await getStorage().repos.assets.findAssetKey("app", appId)) ?? defaultAssetKey("app", appId);
  return `${key}src/`;
}

export async function listAppSources(
  sourcesPath: string,
  agentId: string,
): Promise<{ files?: string[]; warning?: string }> {
  const listing = (async () => {
    const client = await agentFsClientFor(agentId);
    if (!client) return {};
    const matches = await client.provider.glob(`${sourcesPath}**`);
    const files = matches
      .map((path) => path.replace(/^\/+/, ""))
      .filter((path) => path.startsWith(sourcesPath))
      .map((path) => path.slice(sourcesPath.length))
      .sort();
    return { files: files.slice(0, SOURCE_FILES_LIMIT) };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ warning: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ warning: `listing ${sourcesPath} took over 1 s; skipped` }),
      SOURCE_LIST_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([listing, deadline]);
  } catch (error) {
    return {
      warning: `could not list ${sourcesPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
