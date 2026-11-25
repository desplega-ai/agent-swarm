import { parseArgs } from "node:util";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { runnerReadyFile, startScriptRunner } from "./client";

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
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
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
    if (values["allow-shared-uid"] && process.env.NODE_ENV === "production")
      throw new Error("Shared UID is unavailable in production");
    if (values["allow-shared-uid"])
      console.warn(
        scrubSecrets(
          "[script-runner] development override: native children may share the runner UID",
        ),
      );
    let native = false;
    if (process.platform === "linux" && process.geteuid?.() === 0 && Bun.which("setpriv")) {
      const probe = Bun.spawn(
        [
          "setpriv",
          "--reuid=65534",
          "--regid=65534",
          "--clear-groups",
          "--no-new-privs",
          "/bin/sh",
          "-c",
          'test "$(id -u)" = 65534 || exit 1; if test -n "$1" && test -r "$1"; then exit 2; fi',
          "runner-uid-check",
          process.env.SCRIPT_RUNNER_TOKEN_FILE ?? "",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5000, env: {} },
      );
      const status = await probe.exited;
      if (status === 2) throw new Error("Native child can read the runner token file");
      native = status === 0;
    }
    native ||= !!values["allow-shared-uid"];
    runnerReadyFile(process.env.SCRIPT_RUNNER_READY_FILE);
    if (!native)
      console.warn(scrubSecrets("[script-runner] native disabled: separate child UID unavailable"));
    options = {
      apiUrl: url.origin,
      token,
      slots,
      readyFile: process.env.SCRIPT_RUNNER_READY_FILE,
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
