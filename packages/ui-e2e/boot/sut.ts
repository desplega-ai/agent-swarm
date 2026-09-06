import { startSut, stopSut } from "../../../scripts/e2e/sut.ts";

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
  const sut = await startSut(false, {}, parseExtraEnv(Bun.argv.slice(2)));
  let stopPromise: Promise<void> | undefined;
  const stopOnce = () => {
    stopPromise ??= stopSut(sut, false);
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
    `${JSON.stringify({ apiUrl: sut.baseUrl, apiKey: sut.apiKey, dbPath: sut.dbPath })}\n`,
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
