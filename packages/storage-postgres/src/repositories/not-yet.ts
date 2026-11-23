/**
 * Placeholder for a repository method whose Postgres SQL is not written yet.
 * The contract suite on Postgres fails on every call, so none can survive M3.
 */
export function notOnPostgresYet(method: string): never {
  throw new Error(`${method}: not implemented on Postgres yet`);
}
