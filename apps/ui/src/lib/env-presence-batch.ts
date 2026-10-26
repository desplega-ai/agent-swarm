export type EnvPresenceMap = Record<string, boolean>;

// The API rejects more than 200 keys per env-presence request
// (`MAX_ENV_PRESENCE_KEYS` in src/http/config.ts). The configuration catalog
// alone outgrows that, and the hosted dashboard also talks to older APIs, so
// the lookup is split client-side.
export const ENV_PRESENCE_BATCH_SIZE = 200;

export async function fetchEnvPresenceBatched(
  keys: string[],
  fetchBatch: (batch: string[]) => Promise<EnvPresenceMap>,
): Promise<EnvPresenceMap> {
  const unique = [...new Set(keys)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += ENV_PRESENCE_BATCH_SIZE) {
    batches.push(unique.slice(i, i + ENV_PRESENCE_BATCH_SIZE));
  }
  const results = await Promise.all(batches.map(fetchBatch));
  return Object.assign({}, ...results);
}
