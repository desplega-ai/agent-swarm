import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSafeBundlePath } from "../../../../src/extensions/bundle-path.ts";
import type { ApiExtensionPlan } from "../types.ts";

/** What `POST /api/extensions/install` takes for an inline bundle. */
export interface ApiExtensionPayload {
  manifest: { name: string; version?: string; assets?: Record<string, unknown> };
  files: Record<string, string>;
  config?: Record<string, unknown>;
  priority?: number;
}

export interface LoadedApiExtension {
  payload: ApiExtensionPayload;
  /** sha256 of the install body: ties an attempt to the exact bundle and config it ran. */
  sha256: string;
}

export interface InstalledApiExtension {
  id: string;
  /** The extension's own agent id; its `ctx.state` lives in KV namespace `task:agent:<agentId>`. */
  agentId: string | null;
  name: string;
  version: number | null;
  sha256: string;
}

/** One `extension_runs` row as `GET /api/extensions/:id/runs` returns it. */
export interface ApiExtensionRun {
  event: string;
  action: string;
  durationMs: number | null;
  message: string | null;
  agentId: string | null;
  subject: string | null;
  createdAt: string;
}

/**
 * Read one file the bundle names. The bundle is code under test from another actor, so
 * a `..` path, an absolute path, or a symlink anywhere on the path must never reach a
 * host file (the evals env holds provider credentials). The resolved path has to equal
 * the lexical one under the real bundle root, which rejects every symlink, even one
 * that points back inside. Returns null when the file does not exist.
 * shortcut: a hardlink to a host file is not detected, fine while bundles come from git checkouts.
 */
async function readBundleFile(root: string, rel: unknown): Promise<string | null> {
  if (typeof rel !== "string" || !isSafeBundlePath(rel)) {
    throw new Error(`api extension: unsafe bundle path ${JSON.stringify(rel)}`);
  }
  const file = join(await realpath(root), ...rel.split("/"));
  let real: string;
  try {
    real = await realpath(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (real !== file) throw new Error(`api extension: ${rel} is a symlink or leaves the bundle`);
  return readFile(real, "utf8");
}

/**
 * Read a bundle: a directory with `install-payload.json` (used as is), a directory
 * with `manifest.json` (files = the hooks file + script files the manifest names), or
 * a payload JSON file. `plan.config` is merged over the payload's own config.
 * shortcut: skills / workflows / schedules assets are not read from disk, add them
 * when a bundle under test ships one.
 */
export async function loadApiExtension(plan: ApiExtensionPlan): Promise<LoadedApiExtension> {
  const path = resolve(plan.path);
  const isDir = (await stat(path)).isDirectory();
  const readBundleJson = async (rel: string) => {
    const text = await readBundleFile(path, rel);
    return text === null ? null : JSON.parse(text);
  };
  let payload: ApiExtensionPayload;
  const prebuilt = isDir ? await readBundleJson("install-payload.json") : null;
  if (!isDir) {
    // The operator named this file itself, so it is trusted as given.
    payload = JSON.parse(await readFile(path, "utf8"));
  } else if (prebuilt) {
    payload = prebuilt;
  } else {
    const manifest = await readBundleJson("manifest.json");
    if (!manifest) throw new Error(`api extension at ${plan.path}: no manifest.json`);
    const assets = manifest.assets ?? {};
    const rels: unknown[] = [
      assets.hooks,
      ...(Array.isArray(assets.scripts)
        ? assets.scripts.map((s: { file?: unknown }) => s?.file)
        : []),
    ];
    const files: Record<string, string> = {};
    for (const rel of rels) {
      const body = await readBundleFile(path, rel);
      if (body === null) throw new Error(`api extension: ${rel} not found in the bundle`);
      files[rel as string] = body;
    }
    payload = { manifest, files };
  }
  if (!payload.manifest?.name || !payload.files || typeof payload.files !== "object") {
    throw new Error(`api extension at ${plan.path}: need a manifest with a name and a files map`);
  }
  const merged: ApiExtensionPayload = {
    ...payload,
    config: { ...(payload.config ?? {}), ...(plan.config ?? {}) },
  };
  const sha256 = createHash("sha256").update(JSON.stringify(merged)).digest("hex");
  return { payload: merged, sha256 };
}

type ExtensionReply = {
  extension?: { id?: string; agentId?: string | null; version?: number; enabled?: boolean };
};

/** Secret-shaped config keys are stored as secrets. */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Global swarm_config rows the plan copies from the evals process env into the sandbox
 * API (for example the decision-model credential an extension's `systemOne_decide`
 * reads). Throws naming the missing variables; call it before any sandbox exists.
 */
export function resolveApiConfigFromEnv(
  plan: ApiExtensionPlan,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of plan.configFromEnv ?? []) {
    const value = env[key];
    if (value?.trim()) out[key] = value;
    else missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`api extension: ${missing.join(", ")} not set in the evals process env`);
  }
  return out;
}

async function api<T>(
  apiUrl: string,
  swarmKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${swarmKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the request body: it may carry a credential.
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Seed the credential rows, install the bundle and enable it, on one sandbox API.
 * The credential rows are global config with `exportToEnv: false`, so they never
 * reach a worker's env. The caller passes the API's own swarm key.
 */
export async function installApiExtension(opts: {
  apiUrl: string;
  swarmKey: string;
  loaded: LoadedApiExtension;
  configRows: Record<string, string>;
}): Promise<InstalledApiExtension> {
  const { apiUrl, swarmKey, loaded } = opts;
  for (const [key, value] of Object.entries(opts.configRows)) {
    await api(apiUrl, swarmKey, "PUT", "/api/config", {
      scope: "global",
      key,
      value,
      isSecret: SECRET_KEY.test(key),
      exportToEnv: false,
    });
  }
  const installed = await api<ExtensionReply>(
    apiUrl,
    swarmKey,
    "POST",
    "/api/extensions/install",
    loaded.payload,
  );
  const id = installed.extension?.id as string | undefined;
  if (!id) throw new Error("extension install returned no extension id");
  const enabled = await api<ExtensionReply>(
    apiUrl,
    swarmKey,
    "POST",
    `/api/extensions/${id}/enable`,
    {},
  );
  if (enabled.extension?.enabled === false) throw new Error(`extension ${id} did not enable`);
  return {
    id,
    agentId: enabled.extension?.agentId ?? installed.extension?.agentId ?? null,
    name: loaded.payload.manifest.name,
    version: enabled.extension?.version ?? installed.extension?.version ?? null,
    sha256: loaded.sha256,
  };
}

/**
 * What the extension persisted, for per-call logs it keeps (for example a decision log
 * with the decision model's tokens): its `ctx.state` entries plus the explicit KV
 * namespace `ext:<name>` that shipped extensions write their decisions to.
 */
export async function listApiExtensionKv(
  apiUrl: string,
  swarmKey: string,
  ext: Pick<InstalledApiExtension, "agentId" | "name">,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const targets: [string, string][] = [[`ext:${ext.name}`, ""]];
  if (ext.agentId) targets.push([`task:agent:${ext.agentId}`, `ext:${ext.name}:`]);
  for (const [namespace, prefix] of targets) {
    const query = `?limit=1000${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;
    out[namespace] = await api<unknown>(
      apiUrl,
      swarmKey,
      "GET",
      `/api/kv/_/${namespace}${query}`,
    ).catch((err: Error) => ({ error: err.message }));
  }
  return out;
}

/** Every recorded hook run of the extension, newest first (the route caps at 500). */
export async function listApiExtensionRuns(
  apiUrl: string,
  swarmKey: string,
  extensionId: string,
): Promise<ApiExtensionRun[]> {
  const res = await api<{ runs?: ApiExtensionRun[] }>(
    apiUrl,
    swarmKey,
    "GET",
    `/api/extensions/${extensionId}/runs?limit=500`,
  );
  return res.runs ?? [];
}

export interface ToolCoverage {
  /**
   * pre.tool.call runs the extension recorded. Can exceed `allCalls`: hooks also fire for
   * calls the session logs never show (session-end hooks, runner-side calls).
   */
  gatedCalls: number;
  /** Every tool call in the attempt's session logs, native and MCP. */
  allCalls: number;
  /** Logged calls that a hook run covers (per tool, min(all, gated)) / allCalls; null with no calls. */
  coverage: number | null;
  byTool: Record<string, { all: number; gated: number }>;
  /** Hook outcomes (continue, block, error, timeout, ...) for the gated calls. */
  gatedActions: Record<string, number>;
}

/** `mcp__agent-swarm__send-task` and `send-task` are the same tool. */
const bareToolName = (name: string): string => name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");

/**
 * Gated vs all tool calls of one attempt. `toolNames` are the names parsed from the
 * session logs; the runs are the extension's recorded `pre.tool.call` hooks
 * (subject `tool <name>`). Compares counts per tool name, so a hook that fires
 * for MCP calls only shows up as 0 gated on native tools.
 */
export function toolCoverage(runs: ApiExtensionRun[], toolNames: string[]): ToolCoverage {
  const byTool: ToolCoverage["byTool"] = {};
  const bucket = (name: string) => {
    const key = bareToolName(name);
    byTool[key] ??= { all: 0, gated: 0 };
    return byTool[key];
  };
  for (const name of toolNames) bucket(name).all++;
  const gatedActions: Record<string, number> = {};
  let gatedCalls = 0;
  for (const run of runs) {
    if (run.event !== "pre.tool.call") continue;
    gatedCalls++;
    bucket(run.subject?.replace(/^tool /, "") ?? "?").gated++;
    gatedActions[run.action] = (gatedActions[run.action] ?? 0) + 1;
  }
  const allCalls = toolNames.length;
  const coveredCalls = Object.values(byTool).reduce((n, t) => n + Math.min(t.all, t.gated), 0);
  return {
    gatedCalls,
    allCalls,
    coverage: allCalls > 0 ? coveredCalls / allCalls : null,
    byTool,
    gatedActions,
  };
}
