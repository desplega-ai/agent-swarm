/**
 * Baseline dependency rules (Monorepo 01 / DES-647).
 *
 * Encodes the Worker/API DB boundary from scripts/check-db-boundary.sh as real
 * dependency rules. The direct-edge rule mirrors the grep exactly; the reachability
 * rule adds what grep cannot see — worker code reaching be/db through an import
 * chain. Full package-DAG rules land as the @swarm/* packages are extracted
 * (Monorepo 15 / DES-661).
 *
 * Run: bun run check:dep-graph
 */

// Worker-side code (see scripts/check-db-boundary.sh WORKER_PATHS).
const WORKER_SIDE =
  "^src/(commands|hooks|providers|prompts|scripts-runtime|script-runner|utils)/|^src/(cli\\.tsx|claude\\.ts)$";

// Storage packages (Postgres brief D4). The composition root is the only src/
// file that may import an engine package.
const STORAGE_PACKAGES = "^packages/storage(-sqlite|-postgres)?/";
const COMPOSITION_ROOT = "^src/be/storage-root\\.ts$";

// Transitional (Postgres brief M2): files that still open bun:sqlite themselves.
// Each one moves into packages/storage-sqlite during M2; the list must be empty
// at the end of M2. Reason on every line (brief section 10).
const PENDING_SQLITE_IMPORTERS = [
  "^src/be/db\\.ts$", // re-exports the raw handle type; goes with the boot path (M2 step 7)
  "^src/be/db/runtime\\.ts$", // opens the connection and runs initDb; M2 step 7
  "^src/be/migrations/", // the SQLite migration runner; moves with initDb (M2 step 7)
  "^src/be/boot-seeds\\.ts$", // synchronous boot seeds; M2 step 7
  "^src/be/asset-key-audit\\.ts$", // synchronous boot audit; M2 step 7
  "^src/be/connection-bindings-blob-migration\\.ts$", // boot-time data migration; M2 step 7
  "^src/be/oauth-encryption-backfill\\.ts$", // boot-time backfill; M2 step 7
];

module.exports = {
  forbidden: [
    {
      name: "no-storage-package-imports-src",
      comment:
        "Storage packages are standalone (Postgres brief D4): they never import from src/. The server injects logging and accounting hooks instead.",
      severity: "error",
      from: { path: STORAGE_PACKAGES },
      to: { path: "^src/" },
    },
    {
      name: "sqlite-driver-only-in-sqlite-package",
      comment:
        "bun:sqlite is imported only by packages/storage-sqlite (Postgres brief D4). PENDING_SQLITE_IMPORTERS lists the files still moving in M2/M4.",
      severity: "error",
      from: {
        path: "^(src|packages)/",
        pathNot: ["^packages/storage-sqlite/", "^packages/ui-e2e/", ...PENDING_SQLITE_IMPORTERS],
      },
      to: { path: "^bun:sqlite$" },
    },
    {
      name: "postgres-driver-only-in-postgres-package",
      comment:
        "A Postgres driver module is imported only by packages/storage-postgres (Postgres brief D4). Bun.SQL (a named export of the bun module and a global) is invisible to this graph: scripts/storage-checks/check-driver-imports.ts, run by check:dep-graph, rejects it.",
      severity: "error",
      from: { path: "^(src|packages)/", pathNot: ["^packages/storage-postgres/"] },
      to: { path: "^(postgres|pg)$|node_modules/(postgres|pg)/" },
    },
    {
      name: "engine-packages-only-from-composition-root",
      comment:
        "src/ imports the contracts package @desplega/storage and one composition root (src/be/storage-root.ts). No other src/ file imports an engine package.",
      severity: "error",
      from: { path: "^src/", pathNot: [COMPOSITION_ROOT] },
      to: { path: "^packages/storage-(sqlite|postgres)/" },
    },
    {
      name: "contracts-package-imports-no-engine",
      comment:
        "The contracts package is engine-free: no driver and no engine package (Postgres brief D4).",
      severity: "error",
      from: { path: "^packages/storage/" },
      to: { path: "^packages/storage-(sqlite|postgres)/|^bun:sqlite$|^bun$" },
    },
    {
      name: "no-worker-direct-db",
      comment:
        "Worker-side code must not import be/db or bun:sqlite — the API server is the sole DB owner; workers talk HTTP. Same invariant as scripts/check-db-boundary.sh.",
      severity: "error",
      from: { path: WORKER_SIDE },
      to: { path: "^src/be/db|^bun:sqlite$" },
    },
    {
      name: "no-worker-reaches-db",
      comment:
        "Transitive variant: no worker-side module may REACH src/be/db* through any import chain (grep-based checks only see direct edges). WARN not error: every current violation originates from three hybrid CLI entrypoint files that can boot the API in-process (commands/{worker,lead}.ts -> server.ts -> be/db*; cli.tsx -> be/scripts/maintenance.ts -> be/db*). They dissolve at the api-server extraction + apps/api|apps/cli split (Monorepo 13/14); flip this to error there.",
      severity: "warn",
      from: { path: WORKER_SIDE },
      to: { path: "^src/be/db", reachable: true },
    },
    {
      name: "no-package-imports-src",
      comment:
        "packages/model-routing is a pure package shared by the API server, workers, and the UI: no imports from src/, no SQLite, no filesystem. Network goes only through an injected scoped fetch.",
      severity: "error",
      from: { path: "^packages/model-routing/" },
      to: { path: "^src/|^bun:sqlite$|^(node:)?fs(/promises)?$" },
    },
    {
      name: "no-sdk-imports-server",
      comment:
        "packages/agent-swarm-sdk is published to npm and talks to the swarm only over HTTP: no imports from src/ or other workspace packages, no Bun or Node built-ins in its runtime code.",
      severity: "error",
      from: { path: "^packages/agent-swarm-sdk/src/" },
      to: { path: "^src/|^packages/(?!agent-swarm-sdk/)|^bun:|^node:" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    exclude: { path: "\\.(test|spec)\\.tsx?$|^src/tests/" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
