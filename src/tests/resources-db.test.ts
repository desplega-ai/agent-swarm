import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  createResource,
  createSandboxTemplate,
  getResource,
  getResourcePrivate,
  insertResourceCost,
  insertResourceOperation,
} from "../be/resources/db";
import { loadSecretRegistry } from "../be/secret-registry";
import { mintScriptRunToken, resolveSessionToken } from "../be/users";
import { createResourceProvider } from "../resource-providers";
import { clearVolatileSecretsForTesting, scrubSecrets } from "../utils/secret-scrubber";
import { removeResourceTestDb, resourceFixture } from "./resources-test-utils";

const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;
const path = "./test-resources-db.sqlite";
beforeAll(async () => {
  savedTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeResourceTestDb(path);
  initDb(path);
});
afterAll(async () => {
  templateGlobals.__testMigrationTemplate = savedTemplate;
  closeDb();
  await removeResourceTestDb(path);
});

test("resource storage encrypts private values and preserves provenance and idempotent history", async () => {
  const fixture = await resourceFixture();
  const { resource, agent, task, user } = fixture;
  const privateData = await getResourcePrivate(resource.id);
  expect(privateData?.handle).toMatchObject({ externalId: "private-provider-session-handle" });
  const stored = await getDbClient().get<Record<string, unknown>>(
    "SELECT * FROM resources WHERE id = ?",
    [resource.id],
  );
  expect(JSON.stringify(stored)).not.toContain("private-provider-session-handle");
  expect(JSON.stringify(stored)).not.toContain("private-resource-config-value");
  expect(stored?.created_by).toBe(user.id);
  expect(resource).toMatchObject({
    requestedByUserId: user.id,
    sourceTaskId: task.id,
    rootTaskId: task.id,
    generation: 1,
  });
  expect(resource).not.toHaveProperty("providerHandle");
  expect(resource).not.toHaveProperty("privateConfig");
  await expect(
    createResource({
      kind: "sandbox",
      provider: "fake",
      creatorAgentId: fixture.otherAgent.id,
      sourceTaskId: task.id,
      createRequestKey: crypto.randomUUID(),
      expiresAt: resource.expiresAt,
    }),
  ).rejects.toThrow("A valid source task and creator agent are required.");
  const template = await createSandboxTemplate(
    {
      name: "Fake template",
      provider: "fake",
      version: 2,
      privateConfig: { snapshot: {}, secrets: { env: "template-secret-credential-value" } },
    },
    user.id,
  );
  const templated = await createResource({
    kind: "sandbox",
    provider: "fake",
    creatorAgentId: agent.id,
    sourceTaskId: task.id,
    createRequestKey: crypto.randomUUID(),
    templateId: template.id,
    privateConfig: { snapshot: { version: template.version } },
    expiresAt: resource.expiresAt,
  });
  expect(templated.templateVersion).toBe(2);
  const input = {
    resourceId: resource.id,
    generation: 1,
    kind: "exec" as const,
    idempotencyKey: "same-request",
    privateConfig: { snapshot: { command: "bun test" }, secrets: { env: "secret-command-value" } },
  };
  const first = await insertResourceOperation(input);
  expect(await insertResourceOperation(input)).toEqual(first);
  const cost = {
    resourceId: resource.id,
    generation: 1,
    dimension: "browser_hour",
    agentId: agent.id,
    requestedByUserId: user.id,
    sourceTaskId: task.id,
    intervalStart: "2026-11-08T00:00:00.000Z",
    intervalEnd: "2026-11-08T00:01:00.000Z",
    amountUsd: 0.01,
    costSource: "estimated" as const,
    checkpointKey: "checkpoint-1",
  };
  await insertResourceCost(cost);
  await insertResourceCost(cost);
  expect(
    await getDbClient().get("SELECT count(*) AS count FROM resource_costs WHERE resourceId = ?", [
      resource.id,
    ]),
  ).toEqual({ count: 1 });
  await expect(
    insertResourceCost({ ...cost, checkpointKey: "different-source", costSource: "provider" }),
  ).rejects.toThrow();
  await getDbClient().run(
    "UPDATE resources SET state = 'destroyed', liveReservation = 0, providerHandle = NULL WHERE id = ?",
    [resource.id],
  );
  expect((await getResource(resource.id))?.state).toBe("destroyed");
  expect(
    await getDbClient().get(
      "SELECT count(*) AS count FROM resource_operations WHERE resourceId = ?",
      [resource.id],
    ),
  ).toEqual({ count: 1 });
  clearVolatileSecretsForTesting();
  expect((await loadSecretRegistry()).resource).toBeGreaterThan(0);
  expect(scrubSecrets("private-resource-config-value")).toContain("REDACTED");
  const token = await mintScriptRunToken(agent.id, 60_000);
  await getDbClient().run("UPDATE session_tokens SET sourceTaskId = ? WHERE id = ?", [
    task.id,
    token.tokenId,
  ]);
  expect(await resolveSessionToken(token.plaintext)).toMatchObject({
    tokenKind: "agent",
    taskId: null,
    sourceTaskId: task.id,
  });
});

const migrations = (await Array.fromAsync(new Bun.Glob("*.sql").scan("src/be/migrations")))
  .filter((file) => Number.parseInt(file, 10) <= 306)
  .sort();
const previousTail = Math.max(
  ...migrations.map((file) => Number.parseInt(file, 10)).filter((version) => version < 306),
);
for (const tail of new Set([297, previousTail])) {
  test(`fresh and tail ${tail} upgrade produce identical schemas and preserve worker-token bindings`, async () => {
    const dir = `/tmp/resources-migrations-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    const fresh = new Database(":memory:");
    const upgrade = new Database(":memory:");
    try {
      for (const file of migrations.filter((file) => Number.parseInt(file, 10) <= tail))
        await Bun.write(`${dir}/${file}`, Bun.file(`src/be/migrations/${file}`));
      await Bun.write(`${dir}/runner.ts`, Bun.file("src/be/migrations/runner.ts"));
      const previousRunner = (await import(
        `${dir}/runner.ts`
      )) as typeof import("../be/migrations/runner");
      previousRunner.runMigrations(upgrade);
      expect(upgrade.query("SELECT MAX(version) AS tail FROM _migrations").get()).toEqual({
        tail,
      });
      upgrade.run(
        "INSERT INTO session_tokens (id, tokenHash, tokenPreview, agentId, expiresAt, scriptRun) VALUES ('worker', 'hash', 'view', 'agent', '2030-01-01', 0)",
      );
      for (const file of migrations.filter((file) => Number.parseInt(file, 10) > tail))
        await Bun.write(`${dir}/${file}`, Bun.file(`src/be/migrations/${file}`));
      previousRunner.runMigrations(upgrade);
      previousRunner.runMigrations(fresh);
      const schema = (db: Database) =>
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all();
      expect(schema(upgrade)).toEqual(schema(fresh));
      expect(
        upgrade
          .query(
            "SELECT taskId, sourceTaskId, runtimeId, scriptRun FROM session_tokens WHERE id = 'worker'",
          )
          .get(),
      ).toEqual({ taskId: null, sourceTaskId: null, runtimeId: null, scriptRun: 0 });
      expect(upgrade.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      for (const table of [
        "resources",
        "browser_profiles",
        "resource_links",
        "sandbox_templates",
        "resource_operations",
        "resource_costs",
      ]) {
        const columns = fresh
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name);
        expect(columns).toContain("created_by");
        expect(columns).toContain("updated_by");
      }
    } finally {
      fresh.close();
      upgrade.close();
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
}

test("lazy fake adapters preserve kind distinctions and never resume during status reads", async () => {
  for (const kind of ["sandbox", "browser"] as const) {
    const provider = await createResourceProvider({ kind, provider: "fake" });
    const handle = await provider.create({
      ownerId: "test-owner",
      resourceId: crypto.randomUUID(),
      generation: 1,
      timeoutMs: 1000,
      config: {},
    });
    expect(await provider.listOwned("test-owner")).toEqual([handle]);
    expect(await provider.listOwned("different-owner")).toEqual([]);
    if (provider.kind === "sandbox") {
      await expect(provider.readFile(handle, "missing")).rejects.toMatchObject({
        code: "not-found",
      });
      await provider.writeFiles(handle, [
        { path: "marker", data: new TextEncoder().encode("marker") },
      ]);
      await provider.pause(handle);
      expect(await provider.status(handle)).toBe("paused");
      expect(new TextDecoder().decode(await provider.readFile(handle, "marker"))).toBe("marker");
      await provider.resume(handle, 1000);
    } else {
      const profile = await provider.createProfile("test-profile");
      expect(await provider.listProfiles()).toContainEqual({
        externalId: profile,
        name: "test-profile",
      });
      await expect(provider.pause(handle)).rejects.toMatchObject({ code: "unsupported" });
      await provider.stop(handle);
      await expect(provider.connection(handle)).rejects.toMatchObject({ code: "conflict" });
      expect(await provider.status(handle)).toBe("stopped");
    }
    await provider.destroy(handle);
    expect(await provider.status(handle)).toBe("destroyed");
    if (provider.kind === "sandbox") {
      await expect(provider.pause(handle)).rejects.toMatchObject({ code: "conflict" });
      await expect(provider.resume(handle, 1000)).rejects.toMatchObject({ code: "conflict" });
    } else {
      await expect(provider.stop(handle)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await provider.status(handle)).toBe("destroyed");
  }
});

test("private registry preserves public identity and snapshots before and after reload", async () => {
  const f = await resourceFixture();
  const publicValues = [
    f.agent.id,
    f.task.id,
    f.resource.id,
    "https://example.com/repo.git",
    "bun install --frozen-lockfile",
  ];
  const secrets = [
    "private-resource-config-value",
    "private-provider-session-handle",
    "private-profile-provider-handle",
    "private-browser-session-handle",
    "https://credential.invalid/private-browser-connection",
    "https://credential.invalid/private-browser-live",
  ];
  for (const reload of [false, true]) {
    if (reload) {
      clearVolatileSecretsForTesting();
      expect((await loadSecretRegistry()).failed).toBe(0);
    }
    for (const value of publicValues) expect(scrubSecrets(value)).toBe(value);
    for (const value of secrets) expect(scrubSecrets(value)).toContain("REDACTED");
    expect(await getResourcePrivate(f.resource.id)).toMatchObject({
      config: {
        snapshot: { repositoryUrl: publicValues[3], setupCommand: publicValues[4] },
        secrets: { env: { TOKEN: secrets[0] } },
      },
      handle: {
        ownerId: f.agent.id,
        resourceId: f.resource.id,
        generation: 1,
        externalId: secrets[1],
      },
    });
  }
});

test("create reservations deduplicate concurrent requests, detect conflicts, and survive reopen", async () => {
  const f = await resourceFixture();
  const input = {
    kind: "sandbox" as const,
    provider: "fake" as const,
    creatorAgentId: f.agent.id,
    sourceTaskId: f.task.id,
    createRequestKey: "retry-create",
    expiresAt: f.resource.expiresAt,
    privateConfig: {
      snapshot: { command: "bun install", repository: "https://example.com/a.git" },
      secrets: { env: "create-retry-secret-value" },
    },
  };
  const [first, second, third] = await Promise.all([
    createResource(input),
    createResource(input),
    createResource(input),
  ]);
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect((await getResourcePrivate(first.id))?.handle).toBeNull();
  const template = await createSandboxTemplate({
    name: `retry-${crypto.randomUUID()}`,
    provider: "fake",
    version: 1,
    privateConfig: { snapshot: {} },
  });
  for (const changes of [
    { kind: "browser" as const },
    { provider: "e2b" as const },
    { profileId: f.profile.id },
    { templateId: template.id },
    { privateConfig: { snapshot: { command: "bun test" }, secrets: input.privateConfig.secrets } },
    {
      privateConfig: {
        snapshot: input.privateConfig.snapshot,
        secrets: { env: "changed-create-secret-value" },
      },
    },
  ])
    await expect(createResource({ ...input, ...changes })).rejects.toThrow("different request");
  expect(
    await createResource({
      ...input,
      privateConfig: {
        secrets: input.privateConfig.secrets,
        snapshot: { repository: input.privateConfig.snapshot.repository, command: "bun install" },
      },
    }),
  ).toEqual(first);
  await expect(createResource({ ...input, createRequestKey: "" })).rejects.toThrow(
    "explicit create request key",
  );
  closeDb();
  initDb(path);
  expect(await createResource(input)).toEqual(first);
  expect(
    await getDbClient().get(
      "SELECT count(*) AS count FROM resources WHERE creatorAgentId = ? AND sourceTaskId = ? AND createRequestKey = ?",
      [f.agent.id, f.task.id, input.createRequestKey],
    ),
  ).toEqual({ count: 1 });
  expect((await createResource({ ...input, createRequestKey: "another-request" })).id).not.toBe(
    first.id,
  );
});

test("operation retries reject payload, kind, and generation conflicts and preserve recorded generations", async () => {
  const f = await resourceFixture();
  const input = {
    resourceId: f.resource.id,
    generation: 1,
    kind: "exec" as const,
    idempotencyKey: "operation-retry",
    privateConfig: { snapshot: { command: "bun test" } },
  };
  const [first, retry] = await Promise.all([
    insertResourceOperation(input),
    insertResourceOperation(input),
  ]);
  expect(retry).toEqual(first);
  for (const changes of [
    { kind: "destroy" as const },
    { generation: 2 },
    { privateConfig: { snapshot: { command: "bun install" } } },
  ])
    await expect(insertResourceOperation({ ...input, ...changes })).rejects.toThrow(
      "different request",
    );
  await expect(
    insertResourceOperation({ ...input, resourceId: crypto.randomUUID() }),
  ).rejects.toThrow("generation is unavailable");
  await expect(
    insertResourceOperation({ ...input, idempotencyKey: "wrong-generation", generation: 2 }),
  ).rejects.toThrow("generation is unavailable");
  await getDbClient().run("UPDATE resources SET generation = 2 WHERE id = ?", [f.resource.id]);
  await getDbClient().run(
    "UPDATE resource_operations SET status = 'succeeded', lastError = 'Recorded diagnostic' WHERE id = ?",
    [first.id],
  );
  const recorded = await insertResourceOperation(input);
  expect(recorded).toMatchObject({
    id: first.id,
    generation: 1,
    status: "succeeded",
    lastError: "Recorded diagnostic",
  });
  closeDb();
  initDb(path);
  expect(await insertResourceOperation(input)).toEqual(recorded);
  await expect(
    insertResourceOperation({ ...input, idempotencyKey: "new-stale-operation" }),
  ).rejects.toThrow("generation is unavailable");
  expect(
    (
      await insertResourceOperation({
        ...input,
        generation: 2,
        idempotencyKey: "current-generation",
      })
    ).generation,
  ).toBe(2);
});

test("resource link booleans round-trip through integer storage", async () => {
  const { addResourceLink, listResourceLinks } = await import("../be/resources/db");
  const f = await resourceFixture();
  for (const isPrimary of [true, false]) {
    const input = {
      resourceId: f.resource.id,
      kind: "github-pr" as const,
      targetId: crypto.randomUUID(),
      isPrimary,
    };
    await addResourceLink(input);
    expect(await listResourceLinks(f.resource.id)).toContainEqual({
      id: expect.any(String),
      ...input,
    });
  }
});
