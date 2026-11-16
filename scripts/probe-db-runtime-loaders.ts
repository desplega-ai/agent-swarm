/** Verify Phase 2 routing and transaction visibility on isolated files. */

import { Database } from "bun:sqlite";
import { auditAssetKeys, auditAssetKeysAsync } from "../src/be/asset-key-audit";
import {
  closeDb,
  getDbClient,
  getDbDriver,
  getPromptTemplateHistory,
  getPromptTemplates,
  initDb,
  resetPromptTemplateToDefault,
  resolvePromptTemplate,
  upsertPromptTemplate,
  whenDbReady,
} from "../src/be/db";
import { getPromptTemplatesForBoot } from "../src/be/db/prompt-templates-boot";
import {
  getScriptApiConnectionDescriptorsAsync,
  getScriptApiTypesAsync,
  getScriptMcpConnectionDescriptorsAsync,
  getScriptMcpTypesAsync,
  listScriptConnectionsAsync,
  upsertScriptConnection,
} from "../src/be/script-connections";
import {
  scriptSdkTypesWithGeneratedApis,
  scriptStdlibTypesWithGeneratedApis,
} from "../src/be/scripts/typecheck";
import { registerTemplate } from "../src/prompts/registry";
import {
  configureHttpResolver,
  resetHttpResolver,
  resolveTemplate,
  resolveTemplateAsync,
} from "../src/prompts/resolver";

const endpoint = new URL(process.env.DESPLEGA_TELEMETRY_ENDPOINT ?? "");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
  throw new Error("A loopback telemetry endpoint is required.");
}
if (process.platform === "darwin") {
  for (const path of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]) {
    if (await Bun.file(path).exists()) {
      Database.setCustomSQLite(path);
      break;
    }
  }
}
// A preload template would replace the requested file with an in-memory database.
delete (globalThis as { __testMigrationTemplate?: unknown }).__testMigrationTemplate;
const root = `/private/tmp/worker-sqlite-phase2-probe-${crypto.randomUUID()}`;
await Bun.$`mkdir -p ${root}`.quiet();
const results: { driver: string; checks: number; runtimeStatements: number }[] = [];
let checks = 0;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  checks++;
}
const watched =
  /prompt_templates|prompt_template_history|script_connections|FROM users|asset_key_mappings|task_attachments|SELECT id, "key"/;
const postMessage = Worker.prototype.postMessage;
let statements: string[] = [];
Worker.prototype.postMessage = function (
  message: unknown,
  transferOrOptions?: Bun.Transferable[] | Bun.StructuredSerializeOptions,
) {
  const request = message as { sql?: string };
  if (request.sql && watched.test(request.sql)) statements.push(request.sql);
  return Reflect.apply(postMessage, this, [message, transferOrOptions]);
};
try {
  for (const driver of ["sqlite", "worker"] as const) {
    process.env.DB_DRIVER = driver;
    const raw = initDb(`${root}/${driver}.sqlite`);
    await whenDbReady();
    const client = getDbClient();
    const start = checks;
    check(getDbDriver() === driver, "The effective driver differs from the requested driver.");
    const knownUser = crypto.randomUUID();
    const deletedUser = crypto.randomUUID();
    for (const userId of [knownUser, deletedUser]) {
      await client.run("INSERT INTO users (id, name) VALUES (?, ?)", [
        userId,
        "Phase 2 fixture user",
      ]);
      await client.run(
        'INSERT INTO asset_key_mappings (id, provider_id, provider_key, "key", source_entity_type) VALUES (?, ?, ?, ?, ?)',
        [crypto.randomUUID(), "probe", userId, `personal/${userId}/`, "external"],
      );
    }
    await client.run("DELETE FROM users WHERE id = ?", [deletedUser]);
    const bootAudit = auditAssetKeys(raw);
    check(
      bootAudit.checked === 2 && bootAudit.warningCount === 1 && bootAudit.fatalCount === 0,
      "The audit parity fixture differs.",
    );
    const bootTemplates = getPromptTemplatesForBoot({ scope: "global", isDefault: true });
    const query = raw.query;
    const prepare = raw.prepare;
    // Worker runtime loaders must never reach the boot handle. SQLite uses query through its driver.
    const observe = (method: typeof raw.query) =>
      new Proxy(method, {
        apply(target, receiver, args) {
          const sql = String(args[0]);
          if (watched.test(sql)) {
            if (driver === "worker") throw new Error("Runtime SQL reached the boot connection.");
            statements.push(sql);
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    raw.query = observe(query);
    raw.prepare = observe(prepare);
    statements = [];
    try {
      check(
        JSON.stringify(await client.transaction(auditAssetKeysAsync, { readOnly: true })) ===
          JSON.stringify(bootAudit),
        "Audit loaders differ.",
      );
      check(
        JSON.stringify(await getPromptTemplates({ scope: "global", isDefault: true })) ===
          JSON.stringify(bootTemplates),
        "Prompt list loaders differ.",
      );
      registerTemplate({
        eventType: "phase2.parent",
        header: "",
        defaultBody: "code {{name}}",
        variables: [],
        category: "event",
      });
      const parent = await upsertPromptTemplate({
        eventType: "phase2.parent",
        scope: "global",
        body: "{{@template[phase2.child]}}/{{@template[phase2.child]}}",
      });
      await upsertPromptTemplate({ eventType: "phase2.child", scope: "global", body: "{{name}}" });
      check(
        resolveTemplate("phase2.parent", { name: "default" }).text === "code default",
        "The synchronous resolver read an override.",
      );
      const resolved = await resolvePromptTemplate("phase2.parent");
      check(
        resolved && "template" in resolved && resolved.template.id === parent.id,
        "Direct resolution missed the stored template.",
      );
      const rendered = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          resolveTemplateAsync("phase2.parent", { name: String(i) }),
        ),
      );
      check(
        rendered.every((result, i) => result.text === `${i}/${i}` && result.segments?.length === 3),
        "Concurrent reference expansion lost a token.",
      );
      await client.transaction(async (tx) => {
        await upsertPromptTemplate({
          eventType: "phase2.parent",
          scope: "global",
          body: "uncommitted",
        });
        check(
          (await resolveTemplateAsync("phase2.parent", {})).text === "uncommitted",
          "Resolution missed an uncommitted override.",
        );
        check(
          (await getPromptTemplates({ eventType: "phase2.parent" }))[0]?.version ===
            parent.version + 1,
          "Listing missed an uncommitted mutation.",
        );
        check(
          (await getPromptTemplateHistory(parent.id)).length === parent.version + 1,
          "Mutation history is not on the transaction connection.",
        );
        const userId = crypto.randomUUID();
        const mappingId = crypto.randomUUID();
        await tx.run("INSERT INTO users (id, name) VALUES (?, ?)", [
          userId,
          "Phase 2 synthetic user",
        ]);
        await tx.run(
          'INSERT INTO asset_key_mappings (id, provider_id, provider_key, "key", source_entity_type) VALUES (?, ?, ?, ?, ?)',
          [mappingId, "probe", "fixture", `personal/${userId}/`, "external"],
        );
        const audit = await auditAssetKeysAsync(tx);
        check(
          audit.checked === bootAudit.checked + 1 &&
            !audit.issues.some((issue) => issue.entityId === mappingId),
          "Audit missed an uncommitted key or user.",
        );
        await tx.run("DELETE FROM users WHERE id = ?", [userId]);
        check(
          (await auditAssetKeysAsync(tx)).issues.some(
            (issue) => issue.entityId === mappingId && issue.code === "unknown-personal-user",
          ),
          "Audit missed an uncommitted user deletion.",
        );
        await tx.run("DELETE FROM asset_key_mappings WHERE id = ?", [mappingId]);
      });
      // Hold the same runtime write connection. Unrelated calls must wait, then observe the commit.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const owner = client.transaction(async () => {
        await upsertPromptTemplate({ eventType: "phase2.parent", scope: "global", body: "owner" });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const settled = new Set<string>();
      const track = <T>(name: string, promise: Promise<T>): Promise<T> =>
        promise.finally(() => {
          settled.add(name);
        });
      const pending = Promise.all([
        track("listing", getPromptTemplates({ eventType: "phase2.parent" })),
        track("resolution", resolveTemplateAsync("phase2.parent", {})),
        track("reset", resetPromptTemplateToDefault(parent.id, "reset")),
        track(
          "upsert",
          upsertPromptTemplate({ eventType: "phase2.queued", scope: "global", body: "queued" }),
        ),
      ]);
      try {
        await Bun.sleep(20);
        check(
          settled.size === 0,
          `A runtime loader bypassed the transaction owner: ${[...settled].join(", ")}.`,
        );
      } finally {
        release.resolve();
      }
      await owner;
      const queued = await pending;
      check(
        queued[0][0]?.body === "owner" &&
          queued[1].text === "owner" &&
          queued[2].version === parent.version + 3 &&
          queued[3].version === 1,
        "Queued mutation or listing differs.",
      );
      check(
        (await resolveTemplateAsync("phase2.parent", {})).text === "reset" &&
          (await getPromptTemplateHistory(parent.id)).length === parent.version + 3,
        "Reset or its history differs.",
      );
      const beforeRollback = await getPromptTemplateHistory(parent.id);
      try {
        await client.transaction(async () => {
          await upsertPromptTemplate({
            eventType: "phase2.parent",
            scope: "global",
            body: "rolled back",
          });
          await resetPromptTemplateToDefault(parent.id, "also rolled back");
          throw new Error("probe rollback");
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "probe rollback") throw error;
      }
      check(
        JSON.stringify(await getPromptTemplateHistory(parent.id)) ===
          JSON.stringify(beforeRollback) &&
          (await resolveTemplateAsync("phase2.parent", {})).text === "reset",
        "Mutation/history rollback is not atomic.",
      );
      await client.transaction(async () => {
        await upsertScriptConnection({
          slug: "phase2Api",
          kind: "openapi",
          openapiSpecSourceKind: "inline",
          openapiSpecJson: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "probe", version: "1" },
            servers: [{ url: "https://example.test" }],
            paths: {
              "/items": {
                get: { operationId: "listItems", responses: { "200": { description: "items" } } },
              },
            },
          }),
        });
        const apiTypes = await getScriptApiTypesAsync();
        check(
          (await listScriptConnectionsAsync()).some(
            (connection) => connection.slug === "phase2Api",
          ),
          "The connection list missed an uncommitted connection.",
        );
        check(
          apiTypes.includes("phase2Api: Phase2ApiApi") &&
            (await getScriptApiConnectionDescriptorsAsync())[0]?.slug === "phase2Api",
          "Types or descriptors missed an uncommitted connection.",
        );
        check(
          (await getScriptMcpTypesAsync()) === "export interface ScriptMcpRegistry {}\n" &&
            (await getScriptMcpConnectionDescriptorsAsync()).length === 0,
          "Empty MCP loaders differ.",
        );
        check(
          (await scriptSdkTypesWithGeneratedApis()).includes(apiTypes) &&
            (await scriptStdlibTypesWithGeneratedApis()).includes("phase2Api: Phase2ApiApi"),
          "Optional type inputs did not load inside the async body.",
        );
      });
      const http = Bun.serve({
        port: 0,
        fetch: () => new Response("unavailable", { status: 503 }),
      });
      try {
        configureHttpResolver(`http://127.0.0.1:${http.port}`, "phase2-synthetic");
        check(
          (await resolveTemplateAsync("phase2.parent", { name: "http" })).text === "code http",
          "HTTP failure did not preserve the code fallback.",
        );
      } finally {
        resetHttpResolver();
        await http.stop(true);
      }
      for (const table of [
        "prompt_templates",
        "prompt_template_history",
        "script_connections",
        "users",
        "asset_key_mappings",
        "task_attachments",
      ]) {
        check(
          statements.some((sql) => sql.includes(table)),
          `No ${driver} instrumentation for ${table}.`,
        );
      }
      results.push({ driver, checks: checks - start, runtimeStatements: statements.length });
    } finally {
      raw.query = query;
      raw.prepare = prepare;
      await closeDb();
    }
  }
  console.log(JSON.stringify({ checks, results }, null, 2));
} finally {
  Worker.prototype.postMessage = postMessage;
  await closeDb();
  await Bun.$`rm -rf ${root}`.quiet();
}
