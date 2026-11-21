import type { Storage } from "@desplega/storage";
import { getDbClient, isVectorSearchAvailable } from "./db/runtime";
import { createStorage } from "./storage-root";

let storage: Storage | null = null;
let storageKey: { client: unknown; vectorSearch: boolean } | null = null;

/**
 * The storage of this API process: repositories, capabilities, transactions.
 * Built over the current engine client; rebuilt when tests reopen the database.
 */
export function getStorage(): Storage {
  const client = getDbClient();
  const vectorSearch = isVectorSearchAvailable();
  if (!storage || storageKey?.client !== client || storageKey.vectorSearch !== vectorSearch) {
    storage = createStorage(client, { vectorSearch });
    storageKey = { client, vectorSearch };
  }
  return storage;
}
