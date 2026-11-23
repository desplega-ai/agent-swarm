import type { Storage } from "@desplega/storage";
import { getDbClient, getPostgresQueryReader, isVectorSearchAvailable } from "./db/runtime";
import { createStorage } from "./storage-root";

let storage: Storage | null = null;
let storageKey: { client: unknown; vectorSearch: boolean; queryReader: unknown } | null = null;

/**
 * The storage of this API process: repositories, capabilities, transactions.
 * Built over the current engine client; rebuilt when tests reopen the database.
 */
export function getStorage(): Storage {
  const client = getDbClient();
  const vectorSearch = isVectorSearchAvailable();
  const queryReader = getPostgresQueryReader();
  if (
    !storage ||
    storageKey?.client !== client ||
    storageKey.vectorSearch !== vectorSearch ||
    storageKey.queryReader !== queryReader
  ) {
    storage = createStorage(client, { vectorSearch, queryReader });
    storageKey = { client, vectorSearch, queryReader };
  }
  return storage;
}
