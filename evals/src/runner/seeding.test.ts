import { describe, expect, test } from "bun:test";
import type { StackHandle } from "../swarm/sandbox.ts";
import { buildSandboxInfo, validateSqlDumpText } from "./index.ts";

/** Shape of a minimal-but-real `sqlite3 <db> .dump` output (v6 §1.3). */
const VALID_DUMP = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO _migrations VALUES(1,'001_initial_schema.sql','2026-06-11 10:00:00');
INSERT INTO _migrations VALUES(2,'002_add_tasks.sql','2026-06-11 10:00:00');
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT);
INSERT INTO tasks VALUES('t-1','Calibrate the flux capacitor','completed');
COMMIT;
`;

describe("validateSqlDumpText (v6 §1.3 frozen rules)", () => {
  test("accepts a minimal real .dump carrying _migrations DDL + rows", () => {
    expect(validateSqlDumpText(VALID_DUMP)).toBeNull();
  });

  test("accepts quoted/IF NOT EXISTS _migrations variants", () => {
    const quoted = VALID_DUMP.replace(
      "CREATE TABLE _migrations",
      'CREATE TABLE IF NOT EXISTS "_migrations"',
    ).replace(/INSERT INTO _migrations/g, 'INSERT INTO "_migrations"');
    expect(validateSqlDumpText(quoted)).toBeNull();
  });

  test("rejects a dump without the _migrations table", () => {
    const reason = validateSqlDumpText(
      "CREATE TABLE tasks (id TEXT);\nINSERT INTO tasks VALUES('t-1');\n",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("_migrations");
  });

  test("rejects a dump with the _migrations table but no applied rows", () => {
    const noRows = VALID_DUMP.replace(/INSERT INTO _migrations.*\n/g, "");
    const reason = validateSqlDumpText(noRows);
    expect(reason).not.toBeNull();
    expect(reason).toContain("_migrations");
  });

  test("rejects dumps above the 5 MB cap", () => {
    const padded = `${VALID_DUMP}-- ${"x".repeat(5 * 1024 * 1024)}\n`;
    const reason = validateSqlDumpText(padded);
    expect(reason).not.toBeNull();
    expect(reason).toContain("5 MB");
  });
});

describe("buildSandboxInfo — sandboxJson v2 (v6 §0.3 frozen shape + v7 §9.3 member fields)", () => {
  test("snapshot for a 2-worker + lead StackHandle (default, overridden, lead members)", () => {
    const stack = {
      apiSandbox: {
        sandboxID: "ix1-api",
        templateID: "agent-swarm-api-latest",
        domain: "e2b.dev",
        startedAt: "2026-06-11T10:00:00Z",
      },
      workers: [
        {
          index: 0,
          member: {
            index: 0,
            role: "worker",
            spec: { name: "scribe-a", template: "coder" },
            config: { id: "claude-haiku", provider: "claude", model: "haiku" },
            overridden: false,
          },
          sandbox: {
            sandboxID: "ix2-w0",
            templateID: "agent-swarm-worker-latest",
            startedAt: "2026-06-11T10:01:00Z",
            endAt: "2026-06-11T10:31:00Z",
          },
          agentId: "00000000-0000-4000-8000-000000000000",
          version: "1.94.0",
        },
        {
          index: 1,
          member: {
            index: 1,
            role: "worker",
            spec: { configId: "pi-deepseek-flash" },
            config: {
              id: "pi-deepseek-flash",
              provider: "pi",
              model: "openrouter/deepseek/deepseek-v4-flash",
            },
            overridden: true,
          },
          sandbox: {
            sandboxID: "ix3-w1",
            templateID: "agent-swarm-worker-latest",
            startedAt: "2026-06-11T10:01:05Z",
            // no endAt — falls back to expiresAt
            expiresAt: "2026-06-11T10:31:05Z",
          },
          agentId: "11111111-1111-4111-8111-111111111111",
          version: null,
        },
        {
          index: 2,
          member: {
            index: 2,
            role: "lead",
            spec: { name: "custom-lead", configId: "claude-sonnet" },
            config: { id: "claude-sonnet", provider: "claude", model: "sonnet" },
            overridden: true,
          },
          sandbox: {
            sandboxID: "ix4-lead",
            templateID: "agent-swarm-worker-latest",
            startedAt: "2026-06-11T10:01:10Z",
            endAt: "2026-06-11T10:31:10Z",
          },
          agentId: "22222222-2222-4222-8222-222222222222",
          version: "1.94.0",
        },
      ],
      apiUrl: "https://3013-ix1-api.e2b.dev",
      swarmKey: "evals-secret",
      apiVersion: "1.94.0",
      sqlSeed: null,
      redact: (t: string) => t,
      kill: async () => {},
    } as unknown as StackHandle;

    expect(buildSandboxInfo(stack)).toEqual({
      v: 2,
      apiSandboxId: "ix1-api",
      apiTemplate: "agent-swarm-api-latest",
      apiUrl: "https://3013-ix1-api.e2b.dev",
      swarmKey: "evals-secret",
      domain: "e2b.dev",
      apiStartedAt: "2026-06-11T10:00:00Z",
      apiVersion: "1.94.0",
      workers: [
        {
          index: 0,
          sandboxId: "ix2-w0",
          template: "agent-swarm-worker-latest",
          agentId: "00000000-0000-4000-8000-000000000000",
          startedAt: "2026-06-11T10:01:00Z",
          expiresAt: "2026-06-11T10:31:00Z",
          version: "1.94.0",
          name: "scribe-a",
          agentTemplate: "coder",
          role: "worker",
          // not overridden — the effective-config trio stays null (readers
          // fall back to the attempt's cell config)
          configId: null,
          provider: null,
          model: null,
        },
        {
          index: 1,
          sandboxId: "ix3-w1",
          template: "agent-swarm-worker-latest",
          agentId: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-06-11T10:01:05Z",
          expiresAt: "2026-06-11T10:31:05Z",
          version: null,
          name: null,
          agentTemplate: null,
          role: "worker",
          configId: "pi-deepseek-flash",
          provider: "pi",
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        {
          index: 2,
          sandboxId: "ix4-lead",
          template: "agent-swarm-worker-latest",
          agentId: "22222222-2222-4222-8222-222222222222",
          startedAt: "2026-06-11T10:01:10Z",
          expiresAt: "2026-06-11T10:31:10Z",
          version: "1.94.0",
          name: "custom-lead",
          agentTemplate: null,
          role: "lead",
          configId: "claude-sonnet",
          provider: "claude",
          model: "sonnet",
        },
      ],
    });
  });

  test("the §0.3 HARD INVARIANT keys stay top-level in the serialized JSON", () => {
    const stack = {
      apiSandbox: { sandboxID: "a", templateID: "t" },
      workers: [
        {
          index: 0,
          member: {
            index: 0,
            role: "worker",
            spec: {},
            config: { id: "c", provider: "claude" },
            overridden: false,
          },
          sandbox: { sandboxID: "w", templateID: "t" },
          agentId: "id",
          version: null,
        },
      ],
      apiUrl: "https://api",
      swarmKey: "key",
      apiVersion: null,
      sqlSeed: null,
      redact: (t: string) => t,
      kill: async () => {},
    } as unknown as StackHandle;
    const parsed = JSON.parse(JSON.stringify(buildSandboxInfo(stack)));
    // The evals API server reads these two off the stored blob (live transcripts).
    expect(parsed.swarmKey).toBe("key");
    expect(parsed.apiUrl).toBe("https://api");
    expect(parsed.v).toBe(2);
    expect(Array.isArray(parsed.workers)).toBe(true);
  });
});
