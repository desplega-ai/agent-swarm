import type { Database } from "bun:sqlite";

// ---- Start-time probe: does the file already hold encrypted secrets? ----

/** A column whose values may be sealed (encrypted JSON that starts with `prefix`). */
export type SealedColumn = { table: string; column: string };

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True when any secret config row, OAuth app secret, OAuth token set, or
 * sealed replay value is stored encrypted. The API then must reuse its key.
 */
export function hasEncryptedSecretRows(
  database: Database,
  sealedColumns: readonly SealedColumn[],
  sealedPrefix: string,
): boolean {
  if (!/^[A-Za-z0-9:_-]*$/.test(sealedPrefix)) throw new Error("Unsupported sealed prefix");
  const arms = sealedColumns.map(({ table, column }) => {
    if (!PLAIN_IDENT.test(table) || !PLAIN_IDENT.test(column)) {
      throw new Error(`Not a plain identifier: ${table}.${column}`);
    }
    return `UNION ALL SELECT 1 FROM ${table} WHERE ${column} GLOB '${sealedPrefix}*'`;
  });
  return (
    (database
      .prepare<{ present: number }, []>(
        `SELECT EXISTS(
           SELECT 1 FROM swarm_config WHERE isSecret = 1 AND encrypted = 1
           UNION ALL
           SELECT 1 FROM oauth_apps
             WHERE clientSecretEncrypted = 1 AND clientSecret IS NOT NULL
           UNION ALL
           SELECT 1 FROM oauth_authorizations WHERE tokensEncrypted = 1
           ${arms.join("\n           ")}
         ) AS present`,
      )
      .get()?.present ?? 0) === 1
  );
}
