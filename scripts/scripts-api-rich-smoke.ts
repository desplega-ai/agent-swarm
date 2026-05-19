#!/usr/bin/env bun
import { spawn } from "bun";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type Expectation = {
  exitCode?: number;
  error?: string;
  result?: unknown;
  stdoutIncludes?: string[];
  stderrIncludes?: string[];
  responseIncludes?: string[];
  responseExcludes?: string[];
};

type CaseMeta = {
  name: string;
  description?: string;
  intent?: string;
  args?: unknown;
  scope?: "agent" | "global";
  fsMode?: "none" | "workspace-rw";
  expect: Expectation;
};

type SmokeCase = {
  file: string;
  source: string;
  meta: CaseMeta;
};

const apiKey =
  process.env.SCRIPT_SMOKE_API_KEY ||
  (process.env.SWARM_BASE_URL
    ? process.env.AGENT_SWARM_API_KEY || process.env.API_KEY || "123123"
    : "scripts-smoke-api-key-1234567890");
const port = process.env.PORT || "3013";
const baseUrl = (process.env.SWARM_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
const agentId = process.env.SCRIPT_SMOKE_AGENT_ID || "scripts-rich-smoke-agent";
const defaultCasesDir = resolve(import.meta.dir, "script-smoke-cases");
let serverProc: ReturnType<typeof spawn> | undefined;

function fail(message: string): never {
  throw new Error(message);
}

function expandExpectedString(value: string): string {
  return value.replaceAll("__API_KEY__", apiKey).replaceAll("__AGENT_ID__", agentId);
}

function expandExpected(value: unknown): unknown {
  if (typeof value === "string") return expandExpectedString(value);
  if (Array.isArray(value)) return value.map((item) => expandExpected(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandExpected(item),
      ]),
    );
  }
  return value;
}

function readMeta(source: string, file: string): CaseMeta {
  const match = source.match(/^\s*\/\*\s*script-smoke\s*([\s\S]*?)\*\//);
  if (!match?.[1]) {
    fail(`${file}: missing /* script-smoke { ... } */ metadata block`);
  }
  try {
    const parsed = JSON.parse(match[1]) as CaseMeta;
    if (!parsed.name || !parsed.expect) fail(`${file}: metadata requires name and expect`);
    return parsed;
  } catch (error) {
    fail(`${file}: invalid script-smoke JSON: ${error instanceof Error ? error.message : error}`);
  }
}

async function loadCases(paths: string[]): Promise<SmokeCase[]> {
  const files =
    paths.length > 0
      ? paths
      : (await readdir(defaultCasesDir))
          .filter((file) => file.endsWith(".ts"))
          .sort()
          .map((file) => join(defaultCasesDir, file));

  return Promise.all(
    files.map(async (path) => {
      const file = resolve(path);
      const source = await Bun.file(file).text();
      return { file, source, meta: readMeta(source, file) };
    }),
  );
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    fail(`${init.method || "GET"} ${path} failed with ${res.status}: ${text}`);
  }
  return { status: res.status, body, text };
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(250);
  }
  fail(`API did not become healthy at ${baseUrl}`);
}

async function maybeStartServer(): Promise<void> {
  if (process.env.SWARM_BASE_URL) return;
  const logFile = `${process.env.TMPDIR || "/tmp"}/scripts-api-rich-smoke.log`;
  serverProc = spawn({
    cmd: ["bun", "run", "start:http"],
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    env: {
      ...process.env,
      AGENT_SWARM_API_KEY: apiKey,
      API_KEY: apiKey,
      PORT: port,
      MCP_BASE_URL: baseUrl,
    },
  });
}

async function registerAgent(): Promise<void> {
  await request("/api/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Scripts Rich Smoke Agent", isLead: false }),
  });
}

function deepContains(actual: unknown, expected: unknown, path = "result"): void {
  if (expected === null || typeof expected !== "object") {
    if (actual !== expected)
      fail(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) fail(`${path}: expected array, got ${JSON.stringify(actual)}`);
    for (let i = 0; i < expected.length; i++) deepContains(actual[i], expected[i], `${path}[${i}]`);
    return;
  }
  if (actual === null || typeof actual !== "object") {
    fail(
      `${path}: expected object containing ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    deepContains(record[key], value, `${path}.${key}`);
  }
}

function assertIncludes(label: string, actual: string, expected: string[] = []): void {
  for (const rawNeedle of expected) {
    const needle = expandExpectedString(rawNeedle);
    if (!actual.includes(needle)) {
      fail(
        `${label}: expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}

function assertExcludes(label: string, actual: string, expected: string[] = []): void {
  for (const rawNeedle of expected) {
    const needle = expandExpectedString(rawNeedle);
    if (actual.includes(needle)) fail(`${label}: expected to exclude ${JSON.stringify(needle)}`);
  }
}

async function upsertCase(testCase: SmokeCase): Promise<void> {
  const { meta, source } = testCase;
  await request("/api/scripts/upsert", {
    method: "POST",
    body: JSON.stringify({
      name: meta.name,
      description: meta.description || `Rich smoke case ${basename(testCase.file)}`,
      intent: meta.intent || "scripts api rich smoke",
      scope: meta.scope || "agent",
      fsMode: meta.fsMode || "none",
      source,
    }),
  });
}

async function runCase(testCase: SmokeCase): Promise<void> {
  const { meta } = testCase;
  const response = await request("/api/scripts/run", {
    method: "POST",
    body: JSON.stringify({
      name: meta.name,
      args: meta.args ?? {},
      intent: meta.intent || "scripts api rich smoke",
      scope: meta.scope || "agent",
    }),
  });

  const expected = meta.expect;
  if (expected.exitCode !== undefined && response.body.exitCode !== expected.exitCode) {
    fail(
      `${meta.name}: expected exitCode ${expected.exitCode}, got ${response.body.exitCode}: ${response.text}`,
    );
  }
  if (expected.error !== undefined && response.body.error !== expected.error) {
    fail(`${meta.name}: expected error ${expected.error}, got ${response.body.error}`);
  }
  if (expected.result !== undefined) {
    deepContains(response.body.result, expandExpected(expected.result));
  }
  assertIncludes(`${meta.name} stdout`, response.body.stdout || "", expected.stdoutIncludes);
  assertIncludes(`${meta.name} stderr`, response.body.stderr || "", expected.stderrIncludes);
  assertIncludes(`${meta.name} response`, response.text, expected.responseIncludes);
  assertExcludes(`${meta.name} response`, response.text, expected.responseExcludes);
}

async function deleteCase(testCase: SmokeCase): Promise<void> {
  await request(
    `/api/scripts/${encodeURIComponent(testCase.meta.name)}?scope=${testCase.meta.scope || "agent"}`,
    {
      method: "DELETE",
    },
  );
}

async function main(): Promise<void> {
  const cases = await loadCases(process.argv.slice(2));
  if (cases.length === 0) fail("No smoke cases found");

  await maybeStartServer();
  await waitForHealth();
  await registerAgent();

  try {
    for (const testCase of cases) await upsertCase(testCase);
    for (const testCase of cases) {
      await runCase(testCase);
      console.log(`PASS ${testCase.meta.name}`);
    }
  } finally {
    for (const testCase of cases) {
      try {
        await deleteCase(testCase);
      } catch {
        // best effort cleanup
      }
    }
    serverProc?.kill();
  }

  console.log(`scripts API rich smoke passed (${cases.length} cases)`);
}

await main();
