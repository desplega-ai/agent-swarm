import { getStorage } from "../storage";
import { computeContentHash } from "./context-versions";

/** Called inside the same transaction that inserts the referencing run. */
export async function storeScriptRunSource(source: string): Promise<string> {
  const hash = computeContentHash(source);
  await getStorage().repos.scripts.storeScriptRunSource(hash, source);
  return hash;
}
