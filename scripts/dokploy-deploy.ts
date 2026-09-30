#!/usr/bin/env bun
/**
 * Trigger a Dokploy compose deploy and wait for a deployment that started
 * after the trigger to finish.
 *
 * `compose.deploy` returns 200 as soon as the job is queued. Dokploy creates
 * the deployment record only when its queue worker picks the job up, and that
 * pickup is not prompt: on 2026-09-29/30 the record appeared ~10s after the
 * trigger on healthy runs but 278-364s after it on others, and on two runs no
 * record appeared for 12+ minutes. So this script:
 *   1. reads a baseline (the newest deployment createdAt),
 *   2. triggers, and waits up to DOKPLOY_RECORD_WAIT_SECONDS for any record
 *      newer than the baseline,
 *   3. re-triggers up to DOKPLOY_MAX_TRIGGERS times if none appears (a deploy
 *      of an unchanged `:latest` is a seconds-long no-op, so an extra trigger
 *      is cheap),
 *   4. follows the records to a terminal status, and exits non-zero if the
 *      newest one did not end `done`.
 *
 * Any record newer than the baseline counts, not only the one this trigger
 * created: `:latest` is promoted before this runs, so every such deployment
 * pulls the tip. All comparisons use Dokploy's own createdAt timestamps, never
 * the runner clock.
 *
 * Usage:
 *   DOKPLOY_URL=... DOKPLOY_COMPOSE_ID=... DOKPLOY_TOKEN=... bun scripts/dokploy-deploy.ts
 *   bun scripts/dokploy-deploy.ts --check     # read-only: list deployments, trigger nothing
 *
 * Env (optional): DOKPLOY_RECORD_WAIT_SECONDS (420), DOKPLOY_MAX_TRIGGERS (3),
 * DOKPLOY_COMPLETION_TIMEOUT_SECONDS (900), DOKPLOY_POLL_SECONDS (5),
 * DOKPLOY_RETRY_BACKOFF_SECONDS (30).
 */

export type Deployment = {
  deploymentId: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
  errorMessage?: string | null;
};

export type DokployApi = {
  listDeployments(): Promise<Deployment[]>;
  triggerDeploy(): Promise<void>;
};

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type DeployOptions = {
  recordWaitMs: number;
  maxTriggers: number;
  completionTimeoutMs: number;
  pollMs: number;
  retryBackoffMs: number;
};

export const DEFAULT_OPTIONS: DeployOptions = {
  recordWaitMs: 420_000,
  maxTriggers: 3,
  completionTimeoutMs: 900_000,
  pollMs: 5_000,
  retryBackoffMs: 30_000,
};

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

/** A failed HTTP call. `retryable` is false for 4xx other than 408/429: those never converge. */
export class DokployApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DokployApiError";
  }
}

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

function createdMs(d: Deployment): number {
  const ms = Date.parse(d.createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Newest createdAt in the list, or 0. Does not assume the API returns newest-first. */
export function baselineMs(deployments: Deployment[]): number {
  return deployments.reduce((max, d) => Math.max(max, createdMs(d)), 0);
}

/** Records created after the baseline, newest first. */
export function recordsAfter(deployments: Deployment[], baseline: number): Deployment[] {
  return deployments
    .filter((d) => createdMs(d) > baseline)
    .sort((a, b) => createdMs(b) - createdMs(a));
}

async function listOrEmpty(
  api: DokployApi,
  log: (msg: string) => void,
): Promise<Deployment[] | null> {
  try {
    return await api.listDeployments();
  } catch (err) {
    if (err instanceof DokployApiError && !err.retryable) throw err;
    log(`::warning::Could not list deployments (${(err as Error).message}); will retry`);
    return null;
  }
}

export async function deploy(
  api: DokployApi,
  options: DeployOptions,
  clock: Clock,
  log: (msg: string) => void = console.log,
): Promise<Deployment> {
  const initial = await api.listDeployments();
  const baseline = baselineMs(initial);
  log(
    `Baseline: ${initial.length} deployments, newest created ${baseline ? new Date(baseline).toISOString() : "never"}`,
  );

  // Phase 1: trigger until a new deployment record exists.
  let triggers = 0;
  let fresh: Deployment[] = [];
  while (fresh.length === 0 && triggers < options.maxTriggers) {
    triggers += 1;
    try {
      await api.triggerDeploy();
    } catch (err) {
      if (err instanceof DokployApiError && !err.retryable) throw err;
      log(
        `::warning::Trigger ${triggers}/${options.maxTriggers} failed (${(err as Error).message})`,
      );
      if (triggers < options.maxTriggers) await clock.sleep(options.retryBackoffMs);
      continue;
    }
    const triggeredAt = clock.now();
    log(
      `Trigger ${triggers}/${options.maxTriggers} accepted; waiting up to ${options.recordWaitMs / 1000}s for a deployment record`,
    );
    for (;;) {
      const list = await listOrEmpty(api, log);
      if (list) fresh = recordsAfter(list, baseline);
      const waited = clock.now() - triggeredAt;
      if (fresh.length > 0) {
        log(
          `::notice::Deployment ${fresh.at(-1)?.deploymentId} appeared ${Math.round(waited / 1000)}s after trigger ${triggers}`,
        );
        break;
      }
      if (waited >= options.recordWaitMs) break;
      await clock.sleep(Math.min(options.pollMs, options.recordWaitMs - waited));
    }
    if (fresh.length === 0 && triggers < options.maxTriggers) {
      log(
        `::warning::No deployment record ${options.recordWaitMs / 1000}s after trigger ${triggers}; triggering again`,
      );
    }
  }
  if (fresh.length === 0) {
    throw new DeployError(
      `No deployment record appeared after ${triggers} trigger(s), each waited ${options.recordWaitMs / 1000}s. ` +
        "Dokploy accepted the trigger but never started a deployment. Check the Dokploy queue and redeploy the compose manually.",
    );
  }

  // Phase 2: follow every record newer than the baseline to a terminal status.
  const started = clock.now();
  const lastStatus = new Map<string, string>();
  for (;;) {
    const list = await listOrEmpty(api, log);
    const listed = list ? recordsAfter(list, baseline) : [];
    // A failed or empty read keeps the last good view rather than crashing on `records[0]`.
    const records = listed.length > 0 ? listed : fresh;
    fresh = records;
    for (const d of records) {
      if (lastStatus.get(d.deploymentId) !== d.status) {
        log(`Deployment ${d.deploymentId}: ${d.status}`);
        lastStatus.set(d.deploymentId, d.status);
      }
    }
    const newest = records[0];
    if (!newest) throw new DeployError("Deployment list was empty after a deployment appeared");
    if (records.every((d) => TERMINAL_STATUSES.has(d.status))) {
      if (newest.status === "done") {
        log(
          `::notice::Deployment ${newest.deploymentId} finished (${newest.finishedAt ?? "no finishedAt"})`,
        );
        return newest;
      }
      throw new DeployError(
        `Newest deployment ${newest.deploymentId} ended ${newest.status}${newest.errorMessage ? `: ${newest.errorMessage}` : ""}`,
      );
    }
    if (clock.now() - started >= options.completionTimeoutMs) {
      const open = records.filter((d) => !TERMINAL_STATUSES.has(d.status));
      throw new DeployError(
        `Deployment did not finish within ${options.completionTimeoutMs / 1000}s; still ${open.map((d) => `${d.deploymentId}=${d.status}`).join(", ")}`,
      );
    }
    await clock.sleep(options.pollMs);
  }
}

export function createDokployApi(
  baseUrl: string,
  token: string,
  composeId: string,
  fetchImpl: typeof fetch = fetch,
): DokployApi {
  const root = baseUrl.replace(/\/+$/, "");
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": token,
          // Dokploy sits behind Cloudflare, which rejects requests with no recognizable client.
          "user-agent": "agent-swarm-ci-deploy",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new DokployApiError(`network error: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new DokployApiError(`HTTP ${res.status} ${path.split("?")[0]}: ${body}`, retryable);
    }
    return res;
  };
  return {
    async listDeployments() {
      const res = await request(
        `/api/deployment.allByCompose?composeId=${encodeURIComponent(composeId)}`,
      );
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        throw new DokployApiError("deployment.allByCompose did not return an array", true);
      }
      return body as Deployment[];
    },
    async triggerDeploy() {
      await request("/api/compose.deploy", {
        method: "POST",
        body: JSON.stringify({ composeId }),
      });
    },
  };
}

function envSeconds(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n * 1000;
}

export function optionsFromEnv(): DeployOptions {
  const maxRaw = process.env.DOKPLOY_MAX_TRIGGERS;
  const maxTriggers = maxRaw ? Number(maxRaw) : DEFAULT_OPTIONS.maxTriggers;
  if (!Number.isInteger(maxTriggers) || maxTriggers < 1) {
    throw new Error(`DOKPLOY_MAX_TRIGGERS must be a positive integer, got "${maxRaw}"`);
  }
  return {
    recordWaitMs: envSeconds("DOKPLOY_RECORD_WAIT_SECONDS", DEFAULT_OPTIONS.recordWaitMs),
    maxTriggers,
    completionTimeoutMs: envSeconds(
      "DOKPLOY_COMPLETION_TIMEOUT_SECONDS",
      DEFAULT_OPTIONS.completionTimeoutMs,
    ),
    pollMs: envSeconds("DOKPLOY_POLL_SECONDS", DEFAULT_OPTIONS.pollMs),
    retryBackoffMs: envSeconds("DOKPLOY_RETRY_BACKOFF_SECONDS", DEFAULT_OPTIONS.retryBackoffMs),
  };
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function main(): Promise<void> {
  const missing = ["DOKPLOY_URL", "DOKPLOY_COMPOSE_ID", "DOKPLOY_TOKEN"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    console.error(`::error::Missing env: ${missing.join(", ")}`);
    process.exit(2);
  }
  const api = createDokployApi(
    process.env.DOKPLOY_URL as string,
    process.env.DOKPLOY_TOKEN as string,
    process.env.DOKPLOY_COMPOSE_ID as string,
  );
  if (process.argv.includes("--check")) {
    const list = await api.listDeployments();
    const newest = [...list].sort((a, b) => createdMs(b) - createdMs(a))[0];
    console.log(
      `${list.length} deployments; newest: ${newest ? `${newest.deploymentId} ${newest.status} ${newest.createdAt}` : "none"}`,
    );
    return;
  }
  try {
    await deploy(api, optionsFromEnv(), realClock);
  } catch (err) {
    console.error(`::error::${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
