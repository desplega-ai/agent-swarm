import { parseArgs } from "node:util";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { startScriptRunner } from "./client";

export async function runScriptRunner(argv: string[]) {
  let options: Omit<Parameters<typeof startScriptRunner>[0], "onRefused">;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { "api-url": { type: "string" }, "allow-shared-uid": { type: "boolean" } },
      strict: true,
    });
    if (!values["api-url"]) throw new Error("url");
    const url = new URL(values["api-url"]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("url");
    const token = (
      process.env.SCRIPT_RUNNER_TOKEN_FILE
        ? await Bun.file(process.env.SCRIPT_RUNNER_TOKEN_FILE).text()
        : (process.env.SCRIPT_RUNNER_TOKEN ?? "")
    ).trim();
    if (!/^assr_[a-f0-9]{64}$/.test(token)) throw new Error("token");
    const slots = Number(process.env.SCRIPT_RUNNER_SLOTS ?? 2);
    if (!Number.isInteger(slots) || slots < 1 || slots > 1024) throw new Error("slots");
    registerVolatileSecret(token, "script-runner-token");
    const native =
      values["allow-shared-uid"] ||
      (process.platform === "linux" && process.geteuid?.() === 0 && Bun.which("setpriv") !== null);
    if (!native)
      console.warn(scrubSecrets("[script-runner] native disabled: separate child UID unavailable"));
    options = {
      apiUrl: url.origin,
      token,
      slots,
      executors: native ? ["native", "quickjs"] : ["quickjs"],
    };
  } catch {
    console.error(
      scrubSecrets(
        "[script-runner] invalid configuration: require --api-url, runner token and valid slots",
      ),
    );
    process.exitCode = 1;
    return;
  }
  await new Promise<void>((resolve) => {
    const stop = async () => {
      await client.stop();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve();
    };
    const client = startScriptRunner({
      ...options,
      executors: [...options.executors],
      onRefused: () => {
        process.exitCode = 1;
        void stop();
      },
    });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

if (import.meta.main) await runScriptRunner(process.argv.slice(2));
