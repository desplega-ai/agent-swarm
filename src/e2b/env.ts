import { resolve } from "node:path";
import { getApiKey } from "../utils/api-key";
import { isSensitiveKey, scrubSecrets } from "../utils/secret-scrubber";

export type EnvMap = Record<string, string>;

export const DEFAULT_E2B_API_BASE = "https://api.e2b.app";
export const DEFAULT_E2B_ENVD_PORT = 49_983;

export const DEFAULT_E2B_TEMPLATE_NAMES = {
  api: "agent-swarm-api",
  worker: "agent-swarm-worker",
} as const;

export const DEFAULT_E2B_FORWARD_KEYS = [
  "AGENT_SWARM_API_KEY",
  "API_KEY",
  "SECRETS_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "LINEAR_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "BUSINESS_USE_API_KEY",
  "SENTRY_AUTH_TOKEN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SIGNOZ_INGESTION_KEY",
  "DEVIN_API_KEY",
  "DEVIN_ORG_ID",
  "MANAGED_AGENT_ID",
  "MANAGED_ENVIRONMENT_ID",
  "MANAGED_AGENT_MODEL",
  "MANAGED_GITHUB_TOKEN",
  "ARCHIL_MOUNT_TOKEN",
  "ARCHIL_REGION",
  "ARCHIL_SHARED_DISK_NAME",
  "ARCHIL_PERSONAL_DISK_NAME",
  "HARNESS_PROVIDER",
  "MODEL_OVERRIDE",
  "STARTUP_SCRIPT_STRICT",
] as const;

export type SwarmRole = "api" | "worker";

function decodeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseQuotedValue(value: string, quote: '"' | "'"): string | null {
  let escaped = false;
  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== quote) continue;

    const rest = value.slice(i + 1).trim();
    if (rest && !rest.startsWith("#")) return null;

    const inner = value.slice(1, i);
    return quote === '"' ? decodeDoubleQuotedValue(inner) : inner;
  }
  return null;
}

export function parseDotenv(source: string): EnvMap {
  const out: EnvMap = {};

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    const quoted = quote === '"' || quote === "'" ? parseQuotedValue(value, quote) : null;
    if (quoted !== null) {
      value = quoted;
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    out[key] = value;
  }

  return out;
}

export async function readDotenvFile(path: string): Promise<EnvMap> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Env file not found: ${path}`);
  }
  return parseDotenv(await file.text());
}

export async function maybeReadDotenvFile(path: string): Promise<EnvMap> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  return parseDotenv(await file.text());
}

export function parseKeyValue(raw: string, label: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`${label} must be KEY=VALUE`);
  }
  const key = raw.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`${label} has invalid env key: ${key}`);
  }
  return [key, raw.slice(eq + 1)];
}

export function splitKeys(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function selectEnv(source: NodeJS.ProcessEnv | EnvMap, keys: readonly string[]): EnvMap {
  const out: EnvMap = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function resolveSwarmApiKey(env: EnvMap, explicit?: string): string {
  const apiKey = explicit || env.AGENT_SWARM_API_KEY || env.API_KEY || getApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing swarm API key. Pass --api-key or set AGENT_SWARM_API_KEY/API_KEY for E2B sandboxes.",
    );
  }
  return apiKey;
}

export function redactWithEnv(text: string, env: EnvMap): string {
  let out = text;
  const entries = Object.entries(env)
    .filter(([key, value]) => isSensitiveKey(key) && value.length >= 8)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [key, value] of entries) {
    out = out.split(value).join(`[REDACTED:${key}]`);
  }

  return scrubSecrets(out);
}

export function redactObjectWithEnv<T>(value: T, env: EnvMap, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactWithEnv(value, env) as T;
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactObjectWithEnv(item, env, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (isSensitiveKey(normalized) || /TOKEN|SECRET|PASSWORD|PRIVATE_KEY/.test(normalized)) {
      out[key] = `[REDACTED:${key}]`;
      continue;
    }
    out[key] = redactObjectWithEnv(child, env, seen);
  }
  return out as T;
}

export function absolutePath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}
