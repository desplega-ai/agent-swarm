import { registerVolatileSecret, scrubObject, scrubSecrets } from "../utils/secret-scrubber";

export const DEFAULT_COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const HTTP_METHODS = new Set<string>(COMPOSIO_HTTP_METHODS);

export type ComposioHttpMethod = (typeof COMPOSIO_HTTP_METHODS)[number];

export interface ComposioRequestArgs {
  baseUrl: string;
  body?: unknown;
  endpoint: string;
  headers: Record<string, string>;
  method: string;
  query: Array<[string, string]>;
  raw: boolean;
  useOrgKey: boolean;
}

export interface ComposioRequestDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export interface ComposioExecutionResult {
  body: unknown;
  contentType: string | null;
  error?: string;
  formattedBody: string;
  method: string;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  url: string;
}

export function parseComposioArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ComposioRequestArgs {
  const method = argv[0]?.toUpperCase();
  if (!method || !HTTP_METHODS.has(method)) {
    throw new Error(
      "first argument after composio must be an HTTP method: GET, POST, PUT, PATCH, DELETE, or HEAD",
    );
  }

  const endpoint = argv[1];
  if (!endpoint || endpoint.startsWith("-")) {
    throw new Error("endpoint path is required, e.g. /tools");
  }
  assertRelativeComposioPath(endpoint);

  const parsed: ComposioRequestArgs = {
    baseUrl: env.COMPOSIO_BASE_URL || DEFAULT_COMPOSIO_BASE_URL,
    endpoint,
    headers: {},
    method,
    query: [],
    raw: false,
    useOrgKey: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--base-url") {
      parsed.baseUrl = requiredValue(argv, ++i, "--base-url");
    } else if (arg === "--body" || arg === "--data") {
      parsed.body = parseJsonArg(requiredValue(argv, ++i, arg), arg);
    } else if (arg === "--query" || arg === "-q") {
      parsed.query.push(parsePair(requiredValue(argv, ++i, arg), arg));
    } else if (arg === "--header" || arg === "-H") {
      const [key, value] = parseHeader(requiredValue(argv, ++i, arg));
      parsed.headers[key] = value;
    } else if (arg === "--org") {
      parsed.useOrgKey = true;
    } else if (arg === "--raw") {
      parsed.raw = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if ((method === "GET" || method === "HEAD") && parsed.body !== undefined) {
    throw new Error(`${method} requests cannot include --body`);
  }

  return parsed;
}

export async function executeComposioRequest(
  args: ComposioRequestArgs,
  deps: ComposioRequestDeps = {},
): Promise<ComposioExecutionResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  const apiKey = args.useOrgKey ? env.COMPOSIO_ORG_API_KEY : env.COMPOSIO_API_KEY;
  const keyName = args.useOrgKey ? "COMPOSIO_ORG_API_KEY" : "COMPOSIO_API_KEY";

  if (!apiKey) {
    return {
      body: null,
      contentType: null,
      error: `${keyName} is required. Bun auto-loads .env when running the CLI.`,
      formattedBody: "",
      method: args.method,
      ok: false,
      status: 0,
      statusText: "Missing API key",
      text: "",
      url: buildComposioUrl(args.baseUrl, args.endpoint, args.query),
    };
  }

  registerVolatileSecret(apiKey, keyName);

  const url = buildComposioUrl(args.baseUrl, args.endpoint, args.query);
  const headers: Record<string, string> = {
    ...args.headers,
    [args.useOrgKey ? "x-org-api-key" : "x-api-key"]: apiKey,
  };
  if (args.body !== undefined && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      headers,
      method: args.method,
    });
  } catch (err) {
    return {
      body: null,
      contentType: null,
      error: `request failed: ${scrubSecrets(errorMessage(err))}`,
      formattedBody: "",
      method: args.method,
      ok: false,
      status: 0,
      statusText: "Request failed",
      text: "",
      url,
    };
  }

  const text = await response.text();
  const contentType = response.headers.get("Content-Type");
  const body = parseResponseBody(text, contentType);
  const formattedBody = formatResponseBody(text, contentType, args.raw);

  return {
    body: scrubObject(body),
    contentType,
    formattedBody,
    method: args.method,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: scrubSecrets(text),
    url,
  };
}

export function composioArgsFromParts(input: {
  baseUrl?: string;
  body?: unknown;
  endpoint: string;
  headers?: Record<string, string>;
  method: ComposioHttpMethod | string;
  query?: Array<[string, string]> | Record<string, string | number | boolean | null | undefined>;
  raw?: boolean;
  useOrgKey?: boolean;
}): ComposioRequestArgs {
  const method = input.method.toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new Error(`unsupported HTTP method: ${input.method}`);
  }
  if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
    throw new Error(`${method} requests cannot include a body`);
  }
  assertRelativeComposioPath(input.endpoint);

  return {
    baseUrl: input.baseUrl || process.env.COMPOSIO_BASE_URL || DEFAULT_COMPOSIO_BASE_URL,
    body: input.body,
    endpoint: input.endpoint,
    headers: input.headers ?? {},
    method,
    query: normalizeQuery(input.query),
    raw: input.raw ?? false,
    useOrgKey: input.useOrgKey ?? false,
  };
}

export function formatComposioResultForCli(result: ComposioExecutionResult): string {
  if (result.formattedBody) return result.formattedBody;
  return `HTTP ${result.status} ${result.statusText}`.trim();
}

function normalizeQuery(
  query?: Array<[string, string]> | Record<string, string | number | boolean | null | undefined>,
): Array<[string, string]> {
  if (!query) return [];
  if (Array.isArray(query)) return query;
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    pairs.push([key, String(value)]);
  }
  return pairs;
}

function assertRelativeComposioPath(endpoint: string): void {
  if (/^https?:\/\//i.test(endpoint)) {
    throw new Error("endpoint must be a Composio API path, not an absolute URL");
  }
}

function buildComposioUrl(
  baseUrl: string,
  endpoint: string,
  query: Array<[string, string]>,
): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  const url = new URL(cleanEndpoint, normalizedBase);
  for (const [key, value] of query) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

function formatResponseBody(text: string, contentType: string | null, raw: boolean): string {
  if (raw) return scrubSecrets(text);
  const body = parseResponseBody(text, contentType);
  if (body === null || body === "") return "";
  if (body !== text) return scrubSecrets(JSON.stringify(body, null, 2));
  return scrubSecrets(text);
}

function parseResponseBody(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (contentType?.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

function parseJsonArg(value: string, flag: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${flag} must be valid JSON: ${errorMessage(err)}`);
  }
}

function parsePair(raw: string, flag: string): [string, string] {
  const index = raw.indexOf("=");
  if (index <= 0) {
    throw new Error(`${flag} must use key=value`);
  }
  return [raw.slice(0, index), raw.slice(index + 1)];
}

function parseHeader(raw: string): [string, string] {
  const equalsIndex = raw.indexOf("=");
  const colonIndex = raw.indexOf(":");
  const index =
    colonIndex > 0 && (equalsIndex === -1 || colonIndex < equalsIndex) ? colonIndex : equalsIndex;
  if (index <= 0) {
    throw new Error("--header must use Name=value or Name: value");
  }
  return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()];
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
