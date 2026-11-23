import type { DbClient } from "@desplega/storage";

/**
 * Start-time statements of the Postgres engine (the API start in
 * `src/be/db/runtime.ts` reaches them through the composition root).
 */

/** A column whose values may be sealed (encrypted JSON that starts with a prefix). */
export type PostgresSealedColumn = { table: string; column: string };

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The read codec turns a boolean into 0/1 (the SQLite value shape). */
function truthy(value: unknown): boolean {
  return value === true || value === 1;
}

function quoteIdent(name: string): string {
  if (!PLAIN_IDENT.test(name)) throw new Error(`Not a plain identifier: ${name}`);
  return `"${name}"`;
}

/** True when the current schema holds no table or view: this start creates the database. */
export async function isEmptyPostgresDatabase(client: DbClient): Promise<boolean> {
  const row = await client.get<{ present: number | boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'v', 'p', 'm')
     ) AS present`,
  );
  return !truthy(row?.present);
}

/** True when the pgvector extension is installed in this database. */
export async function hasPgvector(client: DbClient): Promise<boolean> {
  const row = await client.get<{ present: number | boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS present`,
  );
  return truthy(row?.present);
}

/**
 * True when any secret config row, OAuth app secret, OAuth token set, or sealed
 * replay value is stored encrypted. The API then must reuse its key. The same
 * rule as the SQLite probe (`packages/storage-sqlite/src/boot/secrets-probe.ts`).
 */
export async function hasEncryptedSecretRowsPostgres(
  client: DbClient,
  sealedColumns: readonly PostgresSealedColumn[],
  sealedPrefix: string,
): Promise<boolean> {
  const arms = sealedColumns.map(
    ({ table, column }) =>
      `UNION ALL SELECT 1 FROM ${quoteIdent(table)} WHERE left(${quoteIdent(column)}, $1) = $2`,
  );
  const row = await client.get<{ present: number | boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM swarm_config WHERE "isSecret" AND encrypted
       UNION ALL
       SELECT 1 FROM oauth_apps
         WHERE "clientSecretEncrypted" AND "clientSecret" IS NOT NULL
       UNION ALL
       SELECT 1 FROM oauth_authorizations WHERE "tokensEncrypted"
       ${arms.join("\n       ")}
     ) AS present`,
    [sealedPrefix.length, sealedPrefix],
  );
  return truthy(row?.present);
}

/** Key of the session advisory lock one API process holds for its whole life (decision D16). */
export const PROCESS_LOCK_KEY = 7_365_420_302n;

/** Key of the write fence of that lock (owner-fence.ts). */
export const OWNER_FENCE_KEY = PROCESS_LOCK_KEY + 1n;

export type ProcessLockOptions = {
  /** How long a second process waits for the lock before it gives up. */
  waitMs: number;
  /** Delay between two attempts. */
  pollMs?: number;
  /**
   * Called once when the lock session ends while the lock is held (a
   * database restart, a dropped connection, a terminated backend). Postgres
   * releases a session lock with its session, so a second process may now
   * take it: the holder must stop writing. Without it, no watch runs.
   */
  onLost?: (reason: string) => void;
  /** How often the watch checks the lock session (default 1000 ms). */
  watchMs?: number;
};

export type ProcessLock = {
  /** Backend pid of the lock session (the write fence checks it, owner-fence.ts). */
  pid: number;
  release(): Promise<void>;
};

/** Thrown when another API process holds the one-process lock of this database. */
export class ProcessLockHeldError extends Error {
  constructor(waitedMs: number) {
    super(
      `[storage] another API process holds this Postgres database (session advisory lock ${PROCESS_LOCK_KEY}). ` +
        `Waited ${Math.round(waitedMs / 1000)} s. One API process per database: stop the other process first.`,
    );
    this.name = "ProcessLockHeldError";
  }
}

/**
 * The one-process guard (decision D16): a session advisory lock on a dedicated
 * connection, held until `release()` or until the process exits. A second
 * process polls for `waitMs`, then fails with `ProcessLockHeldError`.
 */
export async function acquireProcessLock(
  url: string,
  options: ProcessLockOptions,
): Promise<ProcessLock> {
  const pollMs = options.pollMs ?? 500;
  // A dedicated one-connection pool: the lock lives as long as this session.
  const conn = new Bun.SQL({ url, max: 1, idleTimeout: 0, maxLifetime: 0 });
  const started = Date.now();
  let lockPid = 0;
  try {
    for (;;) {
      const rows = (await conn.unsafe(
        "SELECT pg_try_advisory_lock($1) AS locked, pg_backend_pid() AS pid",
        [PROCESS_LOCK_KEY],
      )) as { locked: boolean; pid: number }[];
      if (rows[0]?.locked === true) {
        lockPid = Number(rows[0].pid);
        // Drain the write fence (owner-fence.ts): wait for every write
        // transaction a previous owner started, then let the fence go. A
        // transaction it starts from now on sees that it lost the lock.
        await conn.unsafe("SELECT pg_advisory_lock($1)", [OWNER_FENCE_KEY]);
        await conn.unsafe("SELECT pg_advisory_unlock($1)", [OWNER_FENCE_KEY]);
        break;
      }
      const waited = Date.now() - started;
      if (waited >= options.waitMs) throw new ProcessLockHeldError(waited);
      await Bun.sleep(Math.min(pollMs, options.waitMs - waited));
    }
  } catch (err) {
    await conn.close({ timeout: 1 }).catch(() => {});
    throw err;
  }
  let released = false;
  let watch: ReturnType<typeof setInterval> | undefined;
  const onLost = options.onLost;
  if (onLost) {
    // The pool reconnects by itself after a restart, on a new session that
    // holds no lock: check the backend pid and the granted lock, not only
    // that a query succeeds.
    let checking = false;
    const lost = (reason: string) => {
      if (released || watch === undefined) return;
      clearInterval(watch);
      watch = undefined;
      onLost(reason);
    };
    watch = setInterval(() => {
      if (checking || released) return;
      checking = true;
      (
        conn.unsafe(
          `SELECT pg_backend_pid() AS pid, EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                AND ((classid::bigint << 32) | objid::bigint) = $1) AS held`,
          [PROCESS_LOCK_KEY],
        ) as Promise<{ pid: number; held: boolean }[]>
      )
        .then((rows) => {
          const row = rows[0];
          if (!row || Number(row.pid) !== lockPid) lost("the lock session ended (new backend)");
          else if (row.held !== true) lost("the lock session no longer holds the lock");
        })
        .catch((err: unknown) => lost(`the lock session failed: ${(err as Error).message}`))
        .finally(() => {
          checking = false;
        });
    }, options.watchMs ?? 1000);
    watch.unref?.();
  }
  return {
    pid: lockPid,
    async release() {
      if (released) return;
      released = true;
      if (watch) clearInterval(watch);
      await conn.unsafe("SELECT pg_advisory_unlock($1)", [PROCESS_LOCK_KEY]).catch(() => {});
      await conn.close({ timeout: 1 }).catch(() => {});
    },
  };
}
