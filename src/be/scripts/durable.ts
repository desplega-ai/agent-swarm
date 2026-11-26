import { MAX_KV_BODY_BYTES } from "../../kv-limits";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type ScriptCaller,
  type ScriptExecutorName,
  type ScriptFsMode,
} from "../../scripts-runtime/executors/types";
import type { RunScriptInput, RunScriptOutput } from "../../scripts-runtime/loader";
import type { ScriptRecord } from "../../types";
import type { ScriptRunProvenance } from "../../utils/request-auth-context";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { claimKv, deleteKv, getKv, upsertKv } from "../db";
import { getStorage } from "../storage";
import { runScriptWithRunCredential } from "./run-credential";

type DurableState = { codeVersion: number; stateVersion: number; state: unknown };

export type DurableCallInput = Pick<
  RunScriptInput,
  | "runtimeInstanceId"
  | "sourceTaskId"
  | "toolCallKeyPrefix"
  | "egressSecrets"
  | "failedBindings"
  | "userConfig"
  | "agentFs"
  | "apiConnections"
  | "mcpConnections"
> & {
  script: ScriptRecord;
  objectId: string;
  method: string;
  args?: unknown;
  agentId: string;
  caller: ScriptCaller;
  provenance?: ScriptRunProvenance;
  executor?: ScriptExecutorName | null;
  fsMode?: ScriptFsMode;
  nested?: boolean;
};

export type DurableCallResult =
  | {
      ok: true;
      output: RunScriptOutput;
      object: { id: string; stateVersion: number; destroyed: boolean };
    }
  | {
      ok: false;
      code: "busy" | "reentry" | "not_callable" | "too_large" | "lease_lost" | "run_failed";
      message: string;
      output?: RunScriptOutput;
    };

/** Execute one object method and commit its state while the lease remains valid. */
export async function callDurableObject({
  script,
  objectId,
  method,
  args,
  agentId,
  caller,
  provenance = {},
  executor,
  fsMode,
  nested = false,
  ...runContext
}: DurableCallInput): Promise<DurableCallResult> {
  let signature: { kind?: string; methods?: Record<string, unknown> };
  try {
    signature = JSON.parse(script.signatureJson);
  } catch {
    return { ok: false, code: "not_callable", message: "not callable" };
  }
  if (
    signature?.kind !== "durable" ||
    !signature.methods ||
    !Object.hasOwn(signature.methods, method)
  ) {
    return { ok: false, code: "not_callable", message: "not callable" };
  }
  const identity = `${script.id}:${objectId}`;
  const objectChain = provenance.objectChain ?? [];
  if (objectChain.includes(identity)) {
    return { ok: false, code: "reentry", message: "already in this call chain" };
  }

  const namespace = `durable:${script.id}`;
  const leaseKey = `lease/${objectId}`;
  const stateKey = `state/${objectId}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + (nested ? 5_000 : 30_000);
  for (;;) {
    if (
      await claimKv({
        namespace,
        key: leaseKey,
        value: { token },
        valueType: "json",
        expiresAt: Date.now() + DEFAULT_SCRIPT_RESOURCES.wallClockMs + 10_000,
      })
    )
      break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, code: "busy", message: "object busy" };
    await Bun.sleep(Math.min(remaining, 50 + Math.floor(Math.random() * 351)));
    if (Date.now() >= deadline) return { ok: false, code: "busy", message: "object busy" };
  }

  const client = getStorage();
  const release = async () => {
    await client.transaction(async () => {
      const lease = await getKv(namespace, leaseKey);
      if ((lease?.value as { token?: string } | undefined)?.token === token) {
        await deleteKv(namespace, leaseKey);
      }
    });
  };

  let output: RunScriptOutput | undefined;
  try {
    const entry = await getKv(namespace, stateKey);
    const stored = entry?.value as DurableState | undefined;
    output = await runScriptWithRunCredential(
      {
        ...runContext,
        source: script.source,
        args,
        agentId,
        executor: executor === undefined ? script.executor : executor,
        fsMode: fsMode ?? script.fsMode,
        signal: AbortSignal.timeout(DEFAULT_SCRIPT_RESOURCES.wallClockMs),
        durable: {
          id: objectId,
          method,
          state: stored?.state,
          codeVersion: script.version,
          storedCodeVersion: stored?.codeVersion ?? script.version,
          caller,
        },
      },
      {
        ...provenance,
        objectChain: [...objectChain, identity],
        depth: (provenance.depth ?? 0) + 1,
      },
    );
    if (output.error || output.exitCode !== 0 || !output.durable) {
      await release();
      return { ok: false, code: "run_failed", message: "object run failed", output };
    }
    const { state, destroyed } = output.durable;
    const ttl = output.durable.idleTtlSec;
    const idleTtlSec = typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null;
    const encoded = JSON.stringify(state);
    if (encoded === undefined) {
      await release();
      return { ok: false, code: "run_failed", message: "state must be JSON-serializable" };
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_KV_BODY_BYTES) {
      await release();
      return { ok: false, code: "too_large", message: "state too large" };
    }
    // A version bump is a change too, so `migrate` runs once per code version.
    const changed =
      !stored || stored.codeVersion !== script.version || encoded !== JSON.stringify(stored.state);
    const stateVersion = (stored?.stateVersion ?? 0) + (!destroyed && changed ? 1 : 0);
    const committed = await client.transaction(async () => {
      const lease = await getKv(namespace, leaseKey);
      if ((lease?.value as { token?: string } | undefined)?.token !== token) return false;
      if (destroyed) {
        await deleteKv(namespace, stateKey);
      } else if (changed) {
        await upsertKv({
          namespace,
          key: stateKey,
          value: { codeVersion: script.version, stateVersion, state },
          valueType: "json",
          expiresAt: idleTtlSec !== null ? Date.now() + idleTtlSec * 1000 : null,
        });
      } else if (idleTtlSec !== null) {
        const expiresAt = Date.now() + idleTtlSec * 1000;
        const refreshed = await client.repos.kv.setExpiresAt(namespace, stateKey, expiresAt);
        // A generic KV read can remove the expired row while the method runs.
        if (refreshed === 0) {
          await upsertKv({ namespace, key: stateKey, value: stored, valueType: "json", expiresAt });
        }
      }
      await deleteKv(namespace, leaseKey);
      return true;
    });
    if (!committed) return { ok: false, code: "lease_lost", message: "lease lost" };
    return { ok: true, output, object: { id: objectId, stateVersion, destroyed } };
  } catch (error) {
    await release();
    return {
      ok: false,
      code: "run_failed",
      message: scrubSecrets(error instanceof Error ? error.message : "object run failed"),
      output,
    };
  }
}
