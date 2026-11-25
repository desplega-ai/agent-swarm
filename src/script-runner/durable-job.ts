import { LocalProcessScriptExecutor, type ScriptExecutionHandle } from "../script-workflows/executor";
import type { ScriptRun } from "../types";

/** Runs the guest without an API credential or a database connection. */
export async function startDurableGuest(run: ScriptRun, send: (frame: string) => void) {
  const pending = new Map<string, { send: (frame: string) => Promise<void>; reject: (error: Error) => void }>();
  const execution = await new LocalProcessScriptExecutor().start({
    run, baseUrl: "", apiKey: "",
    capabilityRelay(frame, reply) {
      const request = JSON.parse(frame);
      if (pending.size >= 64 || typeof request.id !== "string" || pending.has(request.id))
        return Promise.reject(new Error("Invalid capability request"));
      return new Promise<void>((resolve, reject) => {
        pending.set(request.id, { send: async (response) => { await reply(response); resolve(); }, reject });
        send(frame);
      });
    },
  });
  return {
    execution,
    receive(frame: string) {
      const response = JSON.parse(frame);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      void request.send(frame).catch(request.reject);
    },
    async stop() {
      for (const request of pending.values()) request.reject(new Error("Guest stopped"));
      pending.clear();
      await execution.terminate();
    },
  };
}
export type DurableGuest = Awaited<ReturnType<typeof startDurableGuest>>;
