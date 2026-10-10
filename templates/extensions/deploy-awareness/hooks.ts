import { type CtxFor, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

// The Dokploy URL and API key are deliberately not config. Extension config is writable by a
// lead, so a key name or a host here would let it point the API process at any env secret and
// any host. Both come from the API process environment instead (see readApiKey, readBaseUrl).
export const config = z.object({
  composeId: z.string().min(1),
  label: z.string().min(1).default("prod"),
  cacheTtlMs: z.number().int().min(0).default(120_000),
  // Stays under the 5s handler limit, which also covers the secret read and the cache writes.
  timeoutMs: z.number().int().min(100).max(4_000).default(2_000),
  // A "running" deployment older than this is a stuck record, not a live deploy.
  staleAfterMs: z.number().int().min(60_000).default(1_800_000),
});

const manifest = {
  name: "deploy-awareness",
  description: "Appends a one-line note to new tasks while a Dokploy compose deploy is in progress",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

type Ctx = CtxFor<typeof manifest>;

type Snapshot = {
  checkedAt: number;
  /** ISO start of the deployment in progress, or null. */
  runningSince: string | null;
  failed?: true;
};

type Deployment = { status?: unknown; createdAt?: unknown; startedAt?: unknown };

const API_KEY_ENV = "DOKPLOY_API_KEY";
const BASE_URL_ENV = "DOKPLOY_BASE_URL";
const DEFAULT_BASE_URL = "https://app.dokploy.com";
const CACHE_KEY = "deploy-status";
// The tail of the note. It does not change with the label or the time, so it marks a task
// that already carries the note (a resume or a follow-up).
const ADVICE =
  "your worker may restart in the next few minutes. Checkpoint with store-progress before long steps.";

// One check at a time per process, so tasks created together share a single Dokploy call.
let inflight: Promise<Snapshot> | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The API process hydrates global swarm_config rows into process.env at boot and on config
// reload. ctx.swarm.config_get cannot serve this: the SDK scrubs every response, so a secret
// comes back as "[REDACTED:<name>]".
function readApiKey(): string {
  const value = process.env[API_KEY_ENV];
  if (!value) throw new Error(`${API_KEY_ENV} is not set in the API process environment`);
  return value;
}

// The key goes out in a request header, so the host must be reached over TLS. The value is not
// echoed: a URL can carry credentials.
function readBaseUrl(): string {
  const raw = process.env[BASE_URL_ENV] || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${BASE_URL_ENV} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${BASE_URL_ENV} must be an https URL`);
  return raw.replace(/\/+$/, "");
}

/** The start of the newest deployment when it is still running, else null. */
function runningSince(deployments: Deployment[], staleAfterMs: number): string | null {
  let latest: { at: number; deployment: Deployment } | undefined;
  for (const deployment of deployments) {
    const at = Date.parse(String(deployment.createdAt));
    // The list is not chronological (compose.one is not), so compare timestamps, not positions.
    if (!Number.isNaN(at) && (!latest || at > latest.at)) latest = { at, deployment };
  }
  if (latest?.deployment.status !== "running") return null;
  const started = Date.parse(String(latest.deployment.startedAt ?? latest.deployment.createdAt));
  const since = Number.isNaN(started) ? latest.at : started;
  return Date.now() - since > staleAfterMs ? null : new Date(since).toISOString();
}

async function fetchRunningSince(ctx: Ctx): Promise<string | null> {
  const apiKey = readApiKey();
  const base = readBaseUrl();
  const response = await fetch(
    `${base}/api/deployment.allByCompose?composeId=${encodeURIComponent(ctx.config.composeId)}`,
    {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.config.timeoutMs)]),
    },
  );
  if (!response.ok) throw new Error(`Dokploy answered ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Dokploy returned no deployment list");
  return runningSince(body as Deployment[], ctx.config.staleAfterMs);
}

async function refresh(ctx: Ctx): Promise<Snapshot> {
  let snapshot: Snapshot;
  try {
    snapshot = { checkedAt: Date.now(), runningSince: await fetchRunningSince(ctx) };
  } catch (error) {
    // Cached like a result, so an outage costs one attempt per window.
    ctx.log.warn(`deploy status check failed, tasks proceed without the note: ${errorText(error)}`);
    snapshot = { checkedAt: Date.now(), runningSince: null, failed: true };
  }
  try {
    await ctx.state.set(CACHE_KEY, snapshot);
  } catch (error) {
    ctx.log.warn(`deploy status cache write failed: ${errorText(error)}`);
  }
  return snapshot;
}

/** Never throws: a throw counts toward auto-disable, and a status check must not block tasks. */
async function deployStartedAt(ctx: Ctx): Promise<string | null> {
  try {
    const cached = await ctx.state.get<Snapshot>(CACHE_KEY);
    if (cached && Date.now() - cached.checkedAt < ctx.config.cacheTtlMs) {
      return cached.runningSince;
    }
    inflight ??= refresh(ctx).finally(() => {
      inflight = undefined;
    });
    return (await inflight).runningSince;
  } catch (error) {
    ctx.log.warn(`deploy status unavailable, tasks proceed without the note: ${errorText(error)}`);
    return null;
  }
}

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.create", async (event, ctx) => {
    if (event.description.includes(ADVICE)) return;
    const startedAt = await deployStartedAt(ctx);
    if (!startedAt) return;
    const time = startedAt.slice(11, 16);
    return modify({
      description: `${event.description}\n\nNote: a ${ctx.config.label} deploy started at ${time} UTC is in progress; ${ADVICE}`,
    });
  });
};

export default extension;
