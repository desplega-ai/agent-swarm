/**
 * Entry of the compiled API binary (`Dockerfile`, `agent-swarm-api`).
 *
 * - `agent-swarm-api db-copy [options]` runs the SQLite to Postgres copy
 *   (`src/be/data-copy-command.ts`) and exits with its code. It does not boot the
 *   API: no listener, no open of DATABASE_PATH through the API start, no
 *   migrations of the SQLite file, no schedulers, integrations or telemetry.
 * - Any other start boots the API (`src/http.ts`), as before.
 *
 * Keep this file in `src/`: the quickjs and sheets workers find their compiled
 * entrypoints by paths relative to the common root of the build entrypoints.
 * Source runs (`bun run start:http`, `bun run dev:http`) keep using `src/http.ts`.
 */
const [command, ...rest] = process.argv.slice(2);

if (command === "db-copy") {
  await import("./utils/console-scrub-install.ts");
  if (rest.includes("--help") || rest.includes("-h")) {
    const [{ dbCopyHelp }, pkg] = await Promise.all([
      import("./commands/db-copy-help.ts"),
      import("../package.json"),
    ]);
    const help = dbCopyHelp("agent-swarm-api");
    console.log(`\nagent-swarm-api db-copy (v${pkg.default.version})\n`);
    console.log(help.description);
    console.log(`\nUsage:\n  ${help.usage}\n`);
    console.log(`Options:\n${help.options}\n`);
    console.log(`Examples:\n${help.examples}\n`);
    process.exit(0);
  }
  const { runDataCopyCommand } = await import("./be/data-copy-command");
  process.exit(await runDataCopyCommand(rest));
} else {
  await import("./http.ts");
}
