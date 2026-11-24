/**
 * Command help text shared by the CLI (`src/cli.tsx`) and the compiled API binary
 * (`src/api-entry.ts`). Keep this module free of imports: the API binary prints
 * `db-copy --help` from it without loading the CLI (Ink, React) or the API.
 */
export type CommandHelp = {
  usage: string;
  description: string;
  options: string;
  examples: string;
};

export function dbCopyHelp(binName: string): CommandHelp {
  return {
    usage: `${binName} db-copy --from <sqlite file> --to <postgres url> [options]`,
    description:
      "Copy a SQLite database file into an empty Postgres database at the same migration head.\nOpens the SQLite file read-only, refuses a target that holds rows, and writes nothing\nwhen a value cannot be stored in Postgres. Compares the row count and a checksum of\nevery table and exits 1 when one differs. Stop the API before you copy.",
    options: [
      "  --from <path>          SQLite database file (default: DATABASE_PATH)",
      "  --to <url>             Target postgres:// URL (default: DATABASE_URL)",
      "  --json <path>          Write the full report (tables, checksums, problems) as JSON",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} db-copy --from ./agent-swarm-db.sqlite --to postgres://swarm@db:5432/swarm`,
      `  DATABASE_PATH=/data/swarm.sqlite DATABASE_URL=postgres://... ${binName} db-copy --json report.json`,
    ].join("\n"),
  };
}
