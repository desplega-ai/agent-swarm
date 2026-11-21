import {
  type ConstraintKind,
  ConstraintViolationError,
  SerializationFailureError,
  StorageError,
} from "@desplega/storage";

/** The SQLSTATE codes this engine maps (Bun.SQL reports them in `errno`). */
export const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  notNullViolation: "23502",
  checkViolation: "23514",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
  characterNotInRepertoire: "22021",
  inFailedTransaction: "25P02",
} as const;

type PgServerError = {
  message: string;
  errno?: string;
  detail?: string;
  table?: string;
  column?: string;
  constraint?: string;
};

function asPgError(err: unknown): PgServerError | null {
  if (typeof err !== "object" || err === null) return null;
  const record = err as PgServerError;
  return typeof record.errno === "string" && typeof record.message === "string" ? record : null;
}

/** `Key (a, b)=(...)` in a unique-violation detail. */
function keyColumns(detail: string | undefined): string[] {
  const match = detail?.match(/^Key \((.+?)\)=/);
  if (!match?.[1]) return [];
  return match[1].split(",").map((column) => column.trim().replace(/^"|"$/g, ""));
}

/**
 * The SQLite message and result code of the same failure. API responses and
 * the existing callers read the SQLite text (`UNIQUE constraint failed: t.c`),
 * so the typed error carries it on both engines.
 */
function sqliteEquivalent(
  kind: ConstraintKind,
  pg: PgServerError,
  checkMessages: CheckMessages | undefined,
): { message: string; code: string } {
  const table = pg.table ?? "";
  switch (kind) {
    case "unique": {
      // SQLite names an index on expressions instead of its columns:
      // `UNIQUE constraint failed: index 'idx_skills_name_scope'`.
      const key = pg.detail?.match(/^Key \((.+?)\)=/)?.[1] ?? "";
      if (key.includes("(") && pg.constraint) {
        return {
          message: `UNIQUE constraint failed: index '${pg.constraint}'`,
          code: "SQLITE_CONSTRAINT_UNIQUE",
        };
      }
      const columns = keyColumns(pg.detail).map((column) => `${table}.${column}`);
      const suffix = columns.length > 0 ? columns.join(", ") : (pg.constraint ?? table);
      return { message: `UNIQUE constraint failed: ${suffix}`, code: "SQLITE_CONSTRAINT_UNIQUE" };
    }
    case "foreignKey":
      return { message: "FOREIGN KEY constraint failed", code: "SQLITE_CONSTRAINT_FOREIGNKEY" };
    case "notNull":
      return {
        message: `NOT NULL constraint failed: ${table}.${pg.column ?? ""}`,
        code: "SQLITE_CONSTRAINT_NOTNULL",
      };
    case "check":
      return {
        message: `CHECK constraint failed: ${(pg.constraint && checkMessages?.[pg.constraint]) ?? pg.constraint ?? table}`,
        code: "SQLITE_CONSTRAINT_CHECK",
      };
  }
}

const CONSTRAINT_KINDS: Record<string, ConstraintKind> = {
  [SQLSTATE.uniqueViolation]: "unique",
  [SQLSTATE.foreignKeyViolation]: "foreignKey",
  [SQLSTATE.notNullViolation]: "notNull",
  [SQLSTATE.checkViolation]: "check",
};

/** A typed error with the SQLite result code, for callers that still read `code`. */
class PostgresConstraintViolationError extends ConstraintViolationError {
  constructor(
    kind: ConstraintKind,
    message: string,
    target: string | null,
    readonly code: string,
    readonly sqlstate: string,
    cause: unknown,
  ) {
    super(kind, message, target, cause);
  }
}

/**
 * SQLite's failure text of each CHECK constraint, by Postgres constraint name
 * (`src/be/migrations/postgres/check-messages.json`, written by the baseline
 * generator). SQLite names the expression; Postgres names the constraint.
 */
export type CheckMessages = Readonly<Record<string, string>>;

/** Map a driver error to the typed errors of `@desplega/storage`. Other errors pass through. */
export function mapPostgresError(err: unknown, checkMessages?: CheckMessages): unknown {
  if (err instanceof StorageError) return err;
  const pg = asPgError(err);
  if (!pg?.errno) return err;
  const kind = CONSTRAINT_KINDS[pg.errno];
  if (kind) {
    const { message, code } = sqliteEquivalent(kind, pg, checkMessages);
    return new PostgresConstraintViolationError(
      kind,
      message,
      pg.constraint ?? pg.table ?? null,
      code,
      pg.errno,
      err,
    );
  }
  if (pg.errno === SQLSTATE.serializationFailure || pg.errno === SQLSTATE.deadlockDetected) {
    const failure = new SerializationFailureError(pg.message, err);
    (failure as SerializationFailureError & { errno: string }).errno = pg.errno;
    return failure;
  }
  return err;
}
