import { heapStats } from "bun:jsc";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { EMBEDDING_DIMENSIONS } from "../src/be/memory/constants";

export { EMBEDDING_DIMENSIONS };
export type Row = Record<string, string | number | null | Uint8Array>;
export type Query = { sql: string; params: SQLQueryBindings[] };

export function threadHeap() {
  const { heapSize, heapCapacity, extraMemorySize, objectCount } = heapStats();
  return { heapSize, heapCapacity, extraMemorySize, objectCount };
}

export function errorDetails(error: unknown) {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: Reflect.get(error, "code"),
      }
    : { name: "Error", message: String(error) };
}

// Match the runtime resolver without importing the API or its database lifecycle.
export function resolveSqliteVecExtensionPath(): string {
  return process.env.SQLITE_VEC_EXTENSION_PATH || require("sqlite-vec").getLoadablePath();
}

export function configureSQLite(customSQLite: string | null) {
  if (process.platform !== "darwin") return { path: null, configured: null };
  if (!customSQLite) throw new Error("macOS requires a SQLite library that supports extensions.");
  const configured = Database.setCustomSQLite(customSQLite);
  if (!configured) throw new Error("The custom SQLite configuration returned false.");
  return { path: customSQLite, configured };
}

export function openDatabase(filename: string, create: boolean) {
  const db = new Database(filename, { create });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    PRAGMA synchronous=NORMAL; PRAGMA cache_size=-64000;
    PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY;`);
  return db;
}

export function checkVector(db: Database, extensionPath: string) {
  db.loadExtension(extensionPath);
  const version = db
    .query<{ version: string }, []>("SELECT vec_version() AS version")
    .get()!.version;
  const vector = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.25);
  db.exec(
    `CREATE VIRTUAL TABLE temp.phase0_vec USING vec0(embedding float[${EMBEDDING_DIMENSIONS}])`,
  );
  try {
    db.query("INSERT INTO temp.phase0_vec(rowid, embedding) VALUES (1, ?)").run(vector);
    const result = db
      .query<{ rowid: number; distance: number }, [Float32Array]>(
        "SELECT rowid, distance FROM temp.phase0_vec WHERE embedding MATCH ? AND k = 1",
      )
      .get(vector);
    if (!version || result?.rowid !== 1 || result.distance !== 0) {
      throw new Error("The vector query returned an unexpected result.");
    }
    return {
      loaded: true,
      version,
      dimensions: vector.length,
      blobBytes: vector.byteLength,
      result,
    };
  } finally {
    db.exec("DROP TABLE temp.phase0_vec");
  }
}

export function execute(db: Database, query: Query) {
  const started = performance.now();
  const rows = db.query<Row, SQLQueryBindings[]>(query.sql).all(...query.params);
  return { rows, executionMs: performance.now() - started };
}

export function seedFixture(db: Database) {
  // Copy fixture shapes, never import bench-sessions.ts because it executes on import.
  // Column order, types, defaults, and nullability match migrations 001 through 338.
  // Foreign keys, triggers, and unrelated indexes are unnecessary for this read benchmark.
  db.exec(`
    CREATE TABLE agent_tasks (
      "id" TEXT,
      "agentId" TEXT,
      "creatorAgentId" TEXT,
      "task" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT ('pending'),
      "source" TEXT NOT NULL DEFAULT ('mcp'),
      "taskType" TEXT,
      "tags" TEXT DEFAULT ('[]'),
      "priority" INTEGER DEFAULT (50),
      "dependsOn" TEXT DEFAULT ('[]'),
      "offeredTo" TEXT,
      "offeredAt" TEXT,
      "acceptedAt" TEXT,
      "rejectionReason" TEXT,
      "slackChannelId" TEXT,
      "slackThreadTs" TEXT,
      "slackUserId" TEXT,
      "mentionMessageId" TEXT,
      "mentionChannelId" TEXT,
      "vcsProvider" TEXT,
      "vcsRepo" TEXT,
      "vcsEventType" TEXT,
      "vcsNumber" INTEGER,
      "vcsCommentId" INTEGER,
      "vcsAuthor" TEXT,
      "vcsUrl" TEXT,
      "parentTaskId" TEXT,
      "claudeSessionId" TEXT,
      "agentmailInboxId" TEXT,
      "agentmailMessageId" TEXT,
      "agentmailThreadId" TEXT,
      "model" TEXT,
      "scheduleId" TEXT,
      "workflowRunId" TEXT,
      "workflowRunStepId" TEXT,
      "createdAt" TEXT NOT NULL,
      "lastUpdatedAt" TEXT NOT NULL,
      "finishedAt" TEXT,
      "failureReason" TEXT,
      "output" TEXT,
      "progress" TEXT,
      "notifiedAt" TEXT,
      "dir" TEXT,
      "outputSchema" TEXT,
      "compactionCount" INTEGER DEFAULT (0),
      "peakContextPercent" REAL,
      "peakContextTokens" INTEGER,
      "contextWindowSize" INTEGER,
      "was_paused" INTEGER NOT NULL DEFAULT (0),
      "credentialKeySuffix" TEXT,
      "credentialKeyType" TEXT,
      "requestedByUserId" TEXT,
      "vcsInstallationId" INTEGER,
      "vcsNodeId" TEXT,
      "slackReplySent" INTEGER DEFAULT (0),
      "swarmVersion" TEXT,
      "contextKey" TEXT,
      "provider" TEXT,
      "providerMeta" TEXT,
      "followUpConfig" TEXT,
      "created_by" TEXT,
      "updated_by" TEXT,
      "harnessVariant" TEXT,
      "harnessVariantMeta" TEXT,
      "modelTier" TEXT,
      "slackProgressMessageTs" TEXT,
      "slackTreeRootMessageTs" TEXT,
      "effort" TEXT,
      "routingAffinity" TEXT,
      "key" TEXT NOT NULL DEFAULT ('shared/'),
      "title" TEXT,
      "slackTriggerMessageTs" TEXT,
      "requestedByUserIdInherited" INTEGER NOT NULL DEFAULT (0),
      "routing_reason" TEXT,
      "routing_note" TEXT,
      "routing_source" TEXT,
      "deferredAt" TEXT,
      "isHumanFree" INTEGER NOT NULL DEFAULT (0),
      "resolvedModel" TEXT,
      "modelSource" TEXT,
      "modelAlias" TEXT,
      "pool_wake_at" TEXT,
      "runtime_instance_id" TEXT,
      "resolvedEffort" TEXT,
      "profile" TEXT,
      "resolvedProfile" TEXT,
      "dispatchedByTaskId" TEXT,
      "fallbackHops" TEXT,
      "slackParticipants" TEXT,
      "sourceStepId" TEXT,
      "sourceScriptRunId" TEXT,
      "modelGroup" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE TABLE agent_memory (
      "id" TEXT,
      "agentId" TEXT,
      "scope" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "summary" TEXT,
      "embedding" BLOB,
      "source" TEXT NOT NULL,
      "sourceTaskId" TEXT,
      "sourcePath" TEXT,
      "chunkIndex" INTEGER DEFAULT (0),
      "totalChunks" INTEGER DEFAULT (1),
      "tags" TEXT DEFAULT ('[]'),
      "createdAt" TEXT NOT NULL,
      "accessedAt" TEXT NOT NULL,
      "expiresAt" TEXT,
      "accessCount" INTEGER NOT NULL DEFAULT (0),
      "embeddingModel" TEXT,
      "alpha" REAL NOT NULL DEFAULT (1.0),
      "beta" REAL NOT NULL DEFAULT (1.0),
      "created_by" TEXT,
      "updated_by" TEXT,
      "contextKey" TEXT,
      "key" TEXT,
      "contentHash" TEXT,
      "version" INTEGER NOT NULL DEFAULT (1),
      "updatedAt" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE TABLE session_logs (
      "id" TEXT,
      "taskId" TEXT,
      "sessionId" TEXT NOT NULL,
      "iteration" INTEGER NOT NULL,
      "cli" TEXT NOT NULL DEFAULT ('claude'),
      "content" TEXT NOT NULL,
      "lineNumber" INTEGER NOT NULL,
      "createdAt" TEXT NOT NULL,
      "reasoningChars" INTEGER,
      "reasoningKind" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE TABLE kv_entries (
      "namespace" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "value_type" TEXT NOT NULL DEFAULT ('json'),
      "expires_at" INTEGER,
      "created_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
      "updated_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
      "created_by" TEXT,
      "updated_by" TEXT,
      PRIMARY KEY ("namespace", "key")
    ) WITHOUT ROWID;
    CREATE INDEX session_page ON session_logs(sessionId, lineNumber);
  `);
  const filler = "lorem ipsum dolor sit amet ".repeat(640).slice(0, 16 * 1024);
  const now = "2026-10-27T12:00:00.000Z";
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const task = db.query(
    `INSERT INTO agent_tasks (id, "key", task, title, status, source, parentTaskId, requestedByUserId, requestedByUserIdInherited, slackChannelId, output, tags, dependsOn, createdAt, lastUpdatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const log = db.query(
    "INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt) VALUES (?,?,?,?,?,?,?,?)",
  );
  const memory = db.query(
    "INSERT INTO agent_memory (id, agentId, scope, name, content, summary, embedding, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, accessedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const kv = db.query(
    "INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      task.run(
        id(i),
        `shared/task/${id(i)}/`,
        `${id(i)} ${filler}`,
        `Session ${i}`,
        i % 7 === 0 ? "in_progress" : "completed",
        i % 3 === 0 ? "slack" : "ui",
        i % 4 === 0 ? null : id(i - 1),
        `benchuser${i % 20}`,
        i % 4 === 0 ? 0 : 1,
        i % 3 === 0 ? `C${i % 40}` : null,
        i % 10 < 7 ? `Done: ${i}` : null,
        '["synthetic","phase0"]',
        "[]",
        now,
        now,
      );
    }
    for (let i = 0; i < 200; i++) {
      log.run(
        id(i),
        id(0),
        "phase0-session",
        1,
        "claude",
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: `${i} ${filler}` },
              {
                type: "tool_use",
                id: id(i),
                name: "Read",
                input: { file_path: "/synthetic/fixture.ts" },
              },
            ],
          },
        }),
        i,
        now,
      );
    }
    for (let i = 0; i < 50; i++) {
      const embedding = Float32Array.from(
        { length: EMBEDDING_DIMENSIONS },
        (_, j) => (i + j + 1) / 1024,
      );
      memory.run(
        id(i),
        id(0),
        "swarm",
        `Memory ${i}`,
        filler.slice(0, 4096),
        filler.slice(0, 256),
        embedding,
        "task_completion",
        id(i),
        null,
        0,
        1,
        '["synthetic","phase0"]',
        now,
        now,
      );
    }
    for (let i = 0; i < 20_000; i++) {
      kv.run(
        "phase0",
        `item-${String(i).padStart(5, "0")}`,
        JSON.stringify({ index: i, content: filler.slice(0, 1024), tags: ["synthetic"] }),
        "json",
        null,
        1793102400000,
        1793102400000,
      );
    }
  }).immediate();
  return {
    columns: Object.fromEntries(
      ["agent_tasks", "agent_memory", "session_logs", "kv_entries"].map((table) => [
        table,
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      ]),
    ),
    tasks: 100,
    sessionLogs: 200,
    memories: 50,
    kvEntries: 20_000,
    taskTextBytes: 16 * 1024,
    logTextBytes: 16 * 1024,
    kvTextBytes: 1024,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    embeddingBytes: EMBEDDING_DIMENSIONS * 4,
  };
}

export const LONG_SQL = `WITH RECURSIVE n(x) AS (
  VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?
) SELECT sum(x) AS total FROM n`;
