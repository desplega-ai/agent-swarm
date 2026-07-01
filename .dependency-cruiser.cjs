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
  "^src/(commands|hooks|providers|prompts|scripts-runtime|utils)/|^src/(cli\\.tsx|claude\\.ts)$|^plugin/opencode-plugins/";

module.exports = {
  forbidden: [
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
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    exclude: { path: "\\.(test|spec)\\.tsx?$|^src/tests/" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
