import { Database } from "bun:sqlite";
import { startSut, stopSut } from "../../../scripts/e2e/sut.ts";
import { seed } from "./seed";

function parseExtraEnv(args: string[]): Record<string, string> {
  const extraEnv: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const assignment =
      argument === "--sut-env"
        ? args[++index]
        : argument?.startsWith("--sut-env=")
          ? argument.slice("--sut-env=".length)
          : undefined;
    if (!assignment) {
      throw new Error(`Unknown or incomplete argument: ${argument ?? "<missing>"}`);
    }
    const equals = assignment.indexOf("=");
    if (equals <= 0) throw new Error(`Expected --sut-env KEY=VALUE, received: ${assignment}`);
    extraEnv[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  return extraEnv;
}

async function main(): Promise<void> {
  const keep = Boolean(process.env.E2E_KEEP);
  const extraEnv = parseExtraEnv(Bun.argv.slice(2));
  const sut = await startSut(keep, {}, { HEARTBEAT_DISABLE: "true", ...extraEnv });
  const manifestPath = `${sut.dbPath}.seed.json`;
  try {
    const db = new Database(sut.dbPath);
    // The API holds the same WAL file; wait for its write lock instead of failing on SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    let manifest: Awaited<ReturnType<typeof seed>>;
    try {
      manifest = await seed({ apiUrl: sut.baseUrl, apiKey: sut.apiKey, db });
    } finally {
      db.close();
    }
    await Bun.write(manifestPath, JSON.stringify(manifest));
  } catch (error) {
    await stopSut(sut, keep);
    if (!keep)
      await Bun.file(manifestPath)
        .delete()
        .catch(() => {});
    throw error;
  }
  let stopPromise: Promise<void> | undefined;
  const stopOnce = () => {
    stopPromise ??= stopSut(sut, keep).finally(async () => {
      if (!keep)
        await Bun.file(manifestPath)
          .delete()
          .catch(() => {});
    });
    return stopPromise;
  };
  const stopForSignal = () => {
    void stopOnce()
      .catch((error) => console.error(error))
      .finally(() => process.exit(0));
  };

  process.once("SIGTERM", stopForSignal);
  process.once("SIGINT", stopForSignal);

  process.stdout.write(
    `${JSON.stringify({ apiUrl: sut.baseUrl, apiKey: sut.apiKey, dbPath: sut.dbPath, manifestPath })}\n`,
  );

  // The parent owns stdin. EOF is the teardown handshake when the worker exits.
  for await (const _chunk of Bun.stdin.stream()) {
  }
  await stopOnce();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
