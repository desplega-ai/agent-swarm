import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  NewScript,
  ScriptConnectionWrite,
  ScriptCredentialBindingWrite,
  ScriptsRepository,
  Storage,
} from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

function newScript(overrides: Partial<NewScript> = {}): NewScript {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    key: `shared/script:${id}/`,
    name: `s-${id.slice(0, 8)}`,
    scope: "global",
    scopeId: null,
    source: "export default 1",
    description: "d",
    intent: "i",
    signatureJson: "{}",
    argsJsonSchema: null,
    contentHash: "h1",
    isScratch: false,
    typeChecked: false,
    fsMode: "none",
    executor: null,
    agentId: "agent-a",
    actor: null,
    now: T0,
    ...overrides,
  };
}

function bindingWrite(overrides: Partial<ScriptCredentialBindingWrite> = {}) {
  return {
    configKey: "K",
    allowedHostsJson: '["api.example.com"]',
    headerTemplate: "Authorization: Bearer {{value}}",
    queryTemplate: null,
    scope: "global",
    scopeId: null,
    active: true,
    authKind: "config",
    oauthAuthorizationId: null,
    source: "user",
    managedByConnectionId: null,
    actor: null,
    now: T0,
    ...overrides,
  } satisfies ScriptCredentialBindingWrite;
}

function connectionWrite(overrides: Partial<ScriptConnectionWrite> = {}): ScriptConnectionWrite {
  return {
    slug: "github",
    displayName: null,
    kind: "openapi",
    scope: "global",
    scopeId: null,
    baseUrl: "https://api.example.com",
    baseUrlSource: "user",
    allowedHostsJson: "[]",
    credentialBindingId: null,
    authType: "none",
    authConfigKey: null,
    authAuthorizationId: null,
    authParamName: null,
    authTemplateOverride: null,
    authHostsOverrideJson: null,
    openapiSpecSourceKind: null,
    openapiSpecSource: null,
    openapiSpecJson: "{}",
    openapiSpecEtag: null,
    openapiSpecFetchedAt: null,
    mcpServerId: null,
    generatedTypes: null,
    generatedRuntimeJson: null,
    generatedAt: null,
    generationError: null,
    enabled: true,
    actor: null,
    now: T0,
    ...overrides,
  };
}

export function scriptsContract(engine: ContractEngine): void {
  describe(`scripts repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ScriptsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.scripts;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insertScript returns the row in the stored value shape", async () => {
      const row = await repo.insertScript(
        newScript({ id: "s1", name: "alpha", isScratch: true, typeChecked: true }),
      );
      expect(row).toMatchObject({
        id: "s1",
        key: "shared/script:s1/",
        name: "alpha",
        scopeId: null,
        version: 1,
        isScratch: 1,
        typeChecked: 1,
        fsMode: "none",
        executor: null,
        createdByAgentId: "agent-a",
        updatedByAgentId: "agent-a",
        createdAt: T0,
        updatedAt: T0,
      });
      expect(await repo.findScriptById("s1")).toEqual(row);
      expect(await repo.findScriptByName("alpha", "global", null)).toEqual(row);
      expect(await repo.findScriptByName("alpha", "agent", "a1")).toBeNull();
    });

    test("metadata and content updates write flags and bump only what they set", async () => {
      await repo.insertScript(newScript({ id: "s1" }));
      const base = {
        description: "d2",
        intent: "i2",
        signatureJson: "{}",
        argsJsonSchema: '{"type":"object"}',
        isScratch: false,
        typeChecked: true,
        fsMode: "workspace-rw",
        executor: "quickjs",
        actor: null,
        agentId: "agent-b",
        now: T1,
      };
      expect(await repo.updateScriptMetadata("s1", base)).toMatchObject({
        description: "d2",
        version: 1,
        typeChecked: 1,
        executor: "quickjs",
        updatedByAgentId: "agent-b",
        updatedAt: T1,
      });
      expect(
        await repo.updateScriptContent("s1", {
          ...base,
          source: "x",
          contentHash: "h2",
          version: 2,
        }),
      ).toMatchObject({ source: "x", contentHash: "h2", version: 2 });
      expect(await repo.updateScriptMetadata("missing", base)).toBeNull();
    });

    test("listScripts orders by scope, scopeId with NULL first, then name", async () => {
      await repo.insertScript(newScript({ name: "b" }));
      await repo.insertScript(newScript({ name: "a" }));
      await repo.insertScript(newScript({ name: "a", scope: "agent", scopeId: "z" }));
      await repo.insertScript(newScript({ name: "c", scope: "agent", scopeId: "y" }));
      await repo.insertScript(
        newScript({ name: "d", scope: "agent", scopeId: "y", isScratch: true }),
      );
      const names = (rows: { name: string; scopeId: string | null }[]) =>
        rows.map((row) => `${row.scopeId ?? "-"}:${row.name}`);
      expect(names(await repo.listScripts({ includeScratch: false }))).toEqual([
        "y:c",
        "z:a",
        "-:a",
        "-:b",
      ]);
      expect(names(await repo.listScripts({ includeScratch: true, scope: "agent" }))).toEqual([
        "y:c",
        "y:d",
        "z:a",
      ]);
      expect(
        names(await repo.listScripts({ includeScratch: false, scope: "global", scopeId: null })),
      ).toEqual(["-:a", "-:b"]);
      expect(names(await repo.listScripts({ includeScratch: false, scopeId: "z" }))).toEqual([
        "z:a",
      ]);
      expect(
        (await repo.listGlobalScriptContentHashes(["a", "b", "nope"]))
          .map((row) => row.name)
          .sort(),
      ).toEqual(["a", "b"]);
      expect(await repo.listGlobalScriptContentHashes([])).toEqual([]);
    });

    test("scratch touch, restore, expiry list and guarded delete", async () => {
      const scratch = { scope: "agent", scopeId: "a1", isScratch: true };
      await repo.insertScript(newScript({ ...scratch, id: "s1", name: "scratch-1" }));
      await repo.insertScript(newScript({ ...scratch, id: "s2", name: "Scratch-2" }));
      await repo.insertScript(newScript({ ...scratch, id: "s3", name: "scratch-3" }));
      await repo.insertScript(newScript({ id: "s4", name: "scratch-4" }));
      expect(await repo.touchScratchScript("s1", T1)).toBe(1);
      // Case-sensitive prefix: "Scratch-2" is not a scratch-* name.
      expect(await repo.touchScratchScript("s2", T1)).toBe(0);
      expect(await repo.touchScratchScript("s4", T1)).toBe(0);
      // A stale fence (an instant other than the stored updatedAt) writes nothing.
      expect(await repo.restoreScratchScriptUpdatedAt("s1", T0, "2026-01-01T00:00:00.000Z")).toBe(
        0,
      );
      expect(await repo.restoreScratchScriptUpdatedAt("s1", T0, T1)).toBe(1);
      expect(await repo.touchScratchScript("s1", T1)).toBe(1);

      const cutoff = "2026-11-21T10:30:00.000Z";
      expect(await repo.listExpiredScratchScripts(cutoff)).toEqual([
        { id: "s3", name: "scratch-3", scopeId: "a1" },
      ]);
      expect(await repo.deleteExpiredScratchScripts(["s1", "s3", "s4"], cutoff)).toEqual(["s3"]);
      expect(await repo.findScriptById("s3")).toBeNull();
      expect(await repo.deleteExpiredScratchScripts([], cutoff)).toEqual([]);
      expect(await repo.deleteScript("s1")).toBe(1);
      expect(await repo.deleteScript("s1")).toBe(0);
    });

    test("replaceArgsJsonSchema writes only while source and schema are unchanged", async () => {
      await repo.insertScript(newScript({ id: "s1", argsJsonSchema: "old" }));
      expect(await repo.replaceArgsJsonSchema("s1", "other", "old", "new")).toBe(0);
      expect(await repo.replaceArgsJsonSchema("s1", "h1", "stale", "new")).toBe(0);
      expect(await repo.replaceArgsJsonSchema("s1", "h1", "old", "new")).toBe(1);
      expect((await repo.findScriptById("s1"))?.argsJsonSchema).toBe("new");
    });

    test("versions: lookup by number and newest by hash, listed newest first", async () => {
      await repo.insertScript(newScript({ id: "s1" }));
      for (const [version, hash] of [
        [1, "h1"],
        [2, "h2"],
        [3, "h1"],
      ] as const) {
        await repo.insertScriptVersion({
          id: `v${version}`,
          scriptId: "s1",
          version,
          source: "x",
          description: "d",
          intent: "i",
          signatureJson: "{}",
          contentHash: hash,
          changedByAgentId: null,
          changedAt: T0,
          changeReason: null,
        });
      }
      expect((await repo.findScriptVersion("s1", 2))?.id).toBe("v2");
      expect(await repo.findScriptVersion("s1", 9)).toBeNull();
      expect((await repo.findLatestScriptVersionByHash("s1", "h1"))?.version).toBe(3);
      expect((await repo.listScriptVersions("s1")).map((row) => row.version)).toEqual([3, 2, 1]);
    });

    test("embeddings: upsert replaces, lists keep createdAt then insertion order", async () => {
      await repo.insertScript(newScript({ id: "s1", name: "one", now: T1 }));
      await repo.insertScript(newScript({ id: "s2", name: "two", now: T0 }));
      await repo.insertScript(newScript({ id: "s3", name: "three", now: T0 }));
      await repo.insertScript(
        newScript({ id: "s4", name: "mine", scope: "agent", scopeId: "a1", now: T0 }),
      );
      await repo.insertScript(newScript({ id: "s5", name: "scratch", isScratch: true }));
      const vec = (n: number) => new Uint8Array(n).fill(1);
      for (const id of ["s1", "s3", "s4", "s5"]) {
        await repo.upsertScriptEmbedding({
          scriptId: id,
          embedding: vec(4),
          embeddingModel: "m1",
          embeddedText: "t",
          embeddedAt: T0,
        });
      }
      await repo.upsertScriptEmbedding({
        scriptId: "s3",
        embedding: vec(8),
        embeddingModel: "m2",
        embeddedText: "t2",
        embeddedAt: T1,
      });

      const embedded = await repo.listEmbeddedScripts({ kind: "agentOrGlobal", scopeId: "a1" });
      expect(embedded.map((row) => row.id)).toEqual(["s3", "s4", "s1"]);
      expect(embedded[0]).toMatchObject({ scriptId: "s3", embeddingModel: "m2", embeddedAt: T1 });
      expect(new Uint8Array(embedded[0]!.embedding!).length).toBe(8);
      expect(
        (await repo.listEmbeddedScripts({ kind: "agent", scopeId: "a1" })).map((row) => row.id),
      ).toEqual(["s4"]);

      const searchable = await repo.listSearchableScripts({ kind: "global" });
      expect(searchable.map((row) => row.id)).toEqual(["s2", "s3", "s1"]);
      expect(searchable[0]).toMatchObject({ scriptId: null, embedding: null, embeddedAt: null });

      expect((await repo.listScriptsMissingEmbedding()).map((row) => row.id)).toEqual(["s2"]);
      expect((await repo.listScriptsWithEmbeddingSizeNot(4)).map((row) => row.id)).toEqual(["s3"]);
      expect(await repo.countEmbeddingsWithSizeNot(4)).toBe(1);
      expect((await repo.listScriptsForReembed()).map((row) => row.id)).toEqual([
        "s2",
        "s3",
        "s4",
        "s1",
      ]);
    });

    test("the re-embed cursor reads non-scratch scripts by id after the cursor", async () => {
      for (const id of ["c3", "c1", "c4", "c2"]) {
        await repo.insertScript(newScript({ id, isScratch: id === "c2" }));
      }
      expect((await repo.listNonScratchScriptsAfter("", 2)).map((row) => row.id)).toEqual([
        "c1",
        "c3",
      ]);
      expect((await repo.listNonScratchScriptsAfter("c3", 10)).map((row) => row.id)).toEqual([
        "c4",
      ]);
      const vec = new Uint8Array(4).fill(1);
      for (const id of ["c1", "c3"]) {
        await repo.upsertScriptEmbedding({
          scriptId: id,
          embedding: vec,
          embeddingModel: "m",
          embeddedText: "t",
          embeddedAt: T0,
        });
      }
      await repo.deleteScriptEmbedding("c1");
      await repo.deleteScriptEmbedding("missing");
      expect((await repo.listScriptsMissingEmbedding()).map((row) => row.id)).toContain("c1");
      expect((await repo.listScriptsMissingEmbedding()).map((row) => row.id)).not.toContain("c3");
    });

    test("script APIs: insert shape, newest first with insertion ties, partial update", async () => {
      await repo.insertScript(newScript({ id: "s1" }));
      const api = (id: string, now: string, token: string | null) =>
        repo.insertScriptApi({
          id,
          scriptId: "s1",
          agentId: "agent-a",
          authMode: token ? "bearer" : "none",
          bearerTokenEncrypted: token,
          label: null,
          actor: null,
          now,
        });
      expect(await api("b", T0, "enc")).toMatchObject({
        id: "b",
        enabled: 1,
        callCount: 0,
        lastUsedAt: null,
        createdAt: T0,
      });
      await api("a", T0, null);
      await api("c", T1, null);
      expect((await repo.listScriptApisForScript("s1")).map((row) => row.id)).toEqual([
        "c",
        "b",
        "a",
      ]);
      expect(await repo.listScriptApiSecrets()).toEqual([{ id: "b", bearerTokenEncrypted: "enc" }]);
      expect(await repo.listScriptApiScriptIds()).toEqual(["s1"]);

      expect(await repo.updateScriptApi("b", {})).toMatchObject({ id: "b", enabled: 1 });
      expect(await repo.updateScriptApi("b", { enabled: false, label: "L" })).toMatchObject({
        enabled: 0,
        label: "L",
      });
      expect(await repo.setScriptApiToken("b", "enc2", null)).toMatchObject({
        bearerTokenEncrypted: "enc2",
      });
      await repo.recordScriptApiUsage("b", T1);
      await repo.recordScriptApiUsage("b", T1);
      expect(await repo.findScriptApiById("b")).toMatchObject({ callCount: 2, lastUsedAt: T1 });
      expect(await repo.deleteScriptApi("b")).toBe(1);
      expect(await repo.deleteScriptApi("b")).toBe(0);
    });

    test("script runs: args, follow-up guard and the source store", async () => {
      await repo.storeScriptRunSource("hash1", "first");
      await repo.storeScriptRunSource("hash1", "second");
      const stored = await storage.executor.get<{ source: string }>(
        sql`SELECT source FROM script_run_sources WHERE hash = ${"hash1"}`,
      );
      expect(stored?.source).toBe("first");

      await storage.executor.run(
        sql`INSERT INTO script_runs (id, "agentId", source, args) VALUES (${"r1"}, ${"agent-a"}, ${"x"}, ${'{"a":1}'})`,
      );
      expect(await repo.getScriptRunArgs("r1")).toEqual({ args: '{"a":1}' });
      expect(await repo.getScriptRunArgs("missing")).toBeNull();
      expect(await repo.getScriptRunFollowUpGuard("r1")).toEqual({ followUpGuard: null });
      await repo.setScriptRunFollowUpGuard("r1", "passed");
      expect(await repo.getScriptRunFollowUpGuard("r1")).toEqual({ followUpGuard: "passed" });
      expect(await repo.getScriptRunFollowUpGuard("missing")).toBeNull();
    });

    test("credential bindings: identity with NULL as '', order by key then insertion", async () => {
      await repo.insertCredentialBinding("b2", bindingWrite({ configKey: "B" }));
      await repo.insertCredentialBinding(
        "b1",
        bindingWrite({ configKey: "B", queryTemplate: "key={{value}}" }),
      );
      const a = await repo.insertCredentialBinding("a1", bindingWrite({ configKey: "A" }));
      expect(a).toMatchObject({ id: "a1", active: 1, scope_id: null, created_at: T0 });
      expect((await repo.listCredentialBindings()).map((row) => row.id)).toEqual([
        "a1",
        "b2",
        "b1",
      ]);
      expect(
        (
          await repo.findCredentialBindingByIdentity({
            configKey: "B",
            scope: "global",
            scopeId: null,
            headerTemplate: "Authorization: Bearer {{value}}",
            queryTemplate: null,
            managedByConnectionId: null,
          })
        )?.id,
      ).toBe("b2");
      expect(
        await repo.updateCredentialBinding("b2", bindingWrite({ configKey: "C", now: T1 })),
      ).toMatchObject({ config_key: "C", updated_at: T1, created_at: T0 });
      expect(await repo.disableCredentialBinding("b2", null, T1)).toMatchObject({ active: 0 });
      expect(await repo.findCredentialBindingById("missing")).toBeNull();
    });

    test("connections: slug lookup, versioned update, enable bump, managed binding delete", async () => {
      const inserted = await repo.insertConnection("c1", connectionWrite());
      expect(inserted).toMatchObject({ id: "c1", enabled: 1, version: 1, scope_id: null });
      await repo.insertConnection(
        "c2",
        connectionWrite({ slug: "github", scope: "agent", scopeId: "a1" }),
      );
      await repo.insertConnection("c3", connectionWrite({ slug: "acme" }));
      expect((await repo.listConnections()).map((row) => row.id)).toEqual(["c3", "c2", "c1"]);
      expect((await repo.findConnectionBySlug("github", "global", null))?.id).toBe("c1");
      expect((await repo.findConnectionBySlug("github", "agent", "a1"))?.id).toBe("c2");

      expect(
        await repo.updateConnection("c1", connectionWrite({ displayName: "GH" }), 1),
      ).toMatchObject({ display_name: "GH", version: 2 });
      // Stale version: no row.
      expect(await repo.updateConnection("c1", connectionWrite(), 1)).toBeNull();
      expect(await repo.setConnectionEnabled("c1", false, null, T1)).toMatchObject({
        enabled: 0,
        version: 3,
        updated_at: T1,
      });
      expect(await repo.setConnectionSpecFetchedAt("c1", T1)).toMatchObject({
        openapi_spec_fetched_at: T1,
        version: 3,
      });

      await storage.transaction(async () => {
        await repo.deferForeignKeys();
        await repo.insertCredentialBinding(
          "mb",
          bindingWrite({ managedByConnectionId: "c1", source: "connection" }),
        );
      });
      expect((await repo.findManagedCredentialBinding("c1"))?.id).toBe("mb");
      // Deferred keys: the managed binding may name a connection inserted later in the transaction.
      await storage.transaction(async () => {
        await repo.deferForeignKeys();
        await repo.insertCredentialBinding(
          "mb-later",
          bindingWrite({ managedByConnectionId: "c-later", source: "connection" }),
        );
        await repo.insertConnection("c-later", connectionWrite({ slug: "later" }));
      });
      expect((await repo.findManagedCredentialBinding("c-later"))?.id).toBe("mb-later");
      await repo.deleteManagedCredentialBindings("c-later");
      await repo.deleteConnection("c-later");
      await repo.deleteManagedCredentialBindings("c1");
      expect(await repo.findManagedCredentialBinding("c1")).toBeNull();
      await repo.deleteConnection("c1");
      expect(await repo.findConnectionById("c1")).toBeNull();
    });

    test("script runs: stored source, list order and filters, guarded updates", async () => {
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', 'idle', ${T0}, ${T0})`);
      await repo.storeScriptRunSource("h1", "console.log(1)");
      const base = {
        agentId: "ag",
        scriptName: "s",
        sourceHash: "h1",
        args: "{}",
        idempotencyKey: null,
        requestedByUserId: null,
        sourceTaskId: null,
        created_by: null,
        updated_by: null,
        startedAt: T0,
      };
      const r1 = await repo.insertScriptRun({ ...base, id: "r1", idempotencyKey: "k1" });
      expect(r1).toMatchObject({ id: "r1", source: "", status: "running", kind: "workflow" });
      await repo.insertScriptRun({ ...base, id: "r2" });
      await repo.insertInlineScriptRun({
        id: "r3",
        agentId: "ag",
        scriptName: "other",
        sourceHash: "h1",
        args: "{}",
        status: "completed",
        output: "1",
        error: null,
        startedAt: T1,
        finishedAt: T1,
        requestedByUserId: null,
        created_by: null,
        updated_by: null,
        apiEndpointId: null,
        sourceStepId: null,
        parentScriptRunId: null,
        objectScriptId: null,
        objectId: null,
        objectMethod: null,
      });
      expect((await repo.findScriptRun("r1"))?.storedSource).toBe("console.log(1)");
      expect((await repo.findScriptRunByIdempotencyKey("k1"))?.id).toBe("r1");
      expect((await repo.listScriptRuns({}, 10, 0)).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
      expect((await repo.listScriptRuns({ scriptName: "s" }, 1, 1)).map((r) => r.id)).toEqual([
        "r1",
      ]);
      expect(await repo.countScriptRuns({ status: "completed" })).toBe(1);
      expect(await repo.countActiveScriptRuns()).toBe(2);
      expect((await repo.listActiveScriptRuns()).map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(await repo.updateScriptRun("r1", {})).toBe(0);
      expect(await repo.updateScriptRun("r3", { status: "failed" }, "not-terminal")).toBe(0);
      expect(await repo.updateScriptRun("r1", { status: "paused" }, "running")).toBe(1);
      expect(await repo.updateScriptRun("r1", { status: "failed" }, "running")).toBe(0);
      expect(
        await repo.updateScriptRun(
          "r1",
          { status: "completed", output: null, pid: 3 },
          "not-terminal",
        ),
      ).toBe(1);
      expect((await repo.findScriptRun("r1"))?.pid).toBe(3);
    });

    test("script run journal: insert once per step, order, counts", async () => {
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', 'idle', ${T0}, ${T0})`);
      await repo.storeScriptRunSource("h1", "x");
      await repo.insertScriptRun({
        id: "r1",
        agentId: "ag",
        scriptName: null,
        sourceHash: "h1",
        args: "{}",
        idempotencyKey: null,
        requestedByUserId: null,
        sourceTaskId: null,
        created_by: null,
        updated_by: null,
        startedAt: T0,
      });
      const step = (id: string, stepKey: string, stepType: string) => ({
        id,
        runId: "r1",
        stepKey,
        stepType,
        config: "{}",
        status: "completed",
        result: null,
        error: null,
        durationMs: 5,
      });
      await repo.insertScriptRunJournalStep(step("j1", "a", "agent-task"));
      await repo.insertScriptRunJournalStep(step("j2", "b", "fetch"));
      await repo.insertScriptRunJournalStep(step("j3", "a", "fetch"));
      expect((await repo.listScriptRunJournalSteps("r1")).map((r) => r.id)).toEqual(["j1", "j2"]);
      expect((await repo.findScriptRunJournalStep("r1", "a"))?.stepType).toBe("agent-task");
      expect((await repo.findScriptRunJournalStep("r1", "a"))?.completedAt).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
      );
      expect(await repo.countScriptRunJournalSteps("r1")).toBe(2);
      expect(await repo.countScriptRunJournalSteps("r1", "agent-task")).toBe(1);
    });
  });
}
