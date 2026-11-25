import { localProcessScriptExecutor } from "../../script-workflows/executor";
import { getNodeEnv } from "../../utils/node-env";
import { runWithCapacityRetry } from "./capacity-retry";
import type { ScriptJob, ScriptRunnerHandle } from "./types";

export function assertSerializableJob(job: ScriptJob): void {
  const seen = new WeakSet<object>();
  function check(value: unknown): void {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new Error("Script job contains a function or symbol");
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new Error("Script job contains a class instance");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("Script job contains a symbol key");
    }
    seen.add(value);
    for (const entry of Object.values(value)) check(entry);
  }
  check(job);
  const copy = JSON.parse(JSON.stringify(job));
  // Optional object fields may be undefined. Other values must survive transport.
  if (!Bun.deepEquals(job, copy)) {
    throw new Error("Script job does not survive JSON serialization");
  }
}

export const embeddedScriptRunner: ScriptRunnerHandle = {
  id: "embedded",
  kind: "embedded",
  startHeld: (input) => localProcessScriptExecutor.start(input),
  async run(job, signal) {
    if (getNodeEnv() === "test") assertSerializableJob(job);
    return runWithCapacityRetry(job, signal);
  },
};
