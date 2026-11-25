export type StorageEngine = "sqlite" | "postgres";

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * `DATABASE_URL` with a `postgres://` or `postgresql://` scheme selects
 * Postgres. No `DATABASE_URL` (or another scheme) selects SQLite at
 * `DATABASE_PATH`. `DATABASE_URL` is a reserved key: only the deployment env sets it.
 */
export function selectStorageEngine(env: NodeJS.ProcessEnv = process.env): StorageEngine {
  const url = env.DATABASE_URL?.trim();
  return url && POSTGRES_URL.test(url) ? "postgres" : "sqlite";
}
