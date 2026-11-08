import { createAgent, createTaskExtended, createUser, getDbClient } from "../be/db";
import { createBrowserProfile, createResource } from "../be/resources/db";
import { registerResourceHandle } from "../be/resources/private-config";
import { sealJson } from "../be/sealed-json";

export async function resourceFixture() {
  const agent = await createAgent({
    name: "resource-worker",
    isLead: false,
    status: "idle",
    maxTasks: 3,
  });
  const otherAgent = await createAgent({ name: "resource-other", isLead: true, status: "idle" });
  const user = await createUser({ name: "resource-owner" });
  const otherUser = await createUser({ name: "resource-other-owner" });
  const task = await createTaskExtended("Resource source", {
    agentId: agent.id,
    requestedByUserId: user.id,
  });
  const sibling = await createTaskExtended("Resource sibling", {
    agentId: agent.id,
    parentTaskId: task.id,
  });
  const foreign = await createTaskExtended("Foreign tree", {
    agentId: otherAgent.id,
    requestedByUserId: otherUser.id,
  });
  const concurrent = await createTaskExtended("Concurrent tree", {
    agentId: agent.id,
    requestedByUserId: otherUser.id,
  });
  const feedback = await createTaskExtended("Different feedback author", {
    agentId: agent.id,
    parentTaskId: task.id,
    requestedByUserId: otherUser.id,
    inheritParentRequester: false,
  });
  const profile = await createBrowserProfile({
    name: "Personal profile",
    provider: "fake",
    ownerScope: "user",
    ownerUserId: user.id,
    privateConfig: { snapshot: {}, secrets: { externalId: "private-profile-provider-handle" } },
  });
  const resource = await createResource(
    {
      kind: "sandbox",
      provider: "fake",
      creatorAgentId: agent.id,
      sourceTaskId: task.id,
      createRequestKey: crypto.randomUUID(),
      expiresAt: "2030-01-01T00:00:00.000Z",
      privateConfig: {
        snapshot: {
          repositoryUrl: "https://example.com/repo.git",
          setupCommand: "bun install --frozen-lockfile",
        },
        secrets: { env: { TOKEN: "private-resource-config-value" } },
      },
    },
    user.id,
  );
  const browser = await createResource(
    {
      kind: "browser",
      provider: "fake",
      creatorAgentId: agent.id,
      sourceTaskId: task.id,
      createRequestKey: crypto.randomUUID(),
      profileId: profile.id,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    user.id,
  );
  // Test-only provider completion. Production create only reserves an ID; Phase 2 owns
  // the generation-checked handle write after provider allocation.
  for (const [record, externalId, connection] of [
    [
      resource,
      "private-provider-session-handle",
      { cdpUrl: "https://credential.invalid/private-browser-connection" },
    ],
    [
      browser,
      "private-browser-session-handle",
      { liveUrl: "https://credential.invalid/private-browser-live" },
    ],
  ] as const) {
    const handle = {
      ownerId: agent.id,
      resourceId: record.id,
      generation: record.generation,
      externalId,
      connection,
    };
    registerResourceHandle(handle, `resource:${record.id}`);
    await getDbClient().run("UPDATE resources SET providerHandle = ? WHERE id = ?", [
      sealJson(handle),
      record.id,
    ]);
  }
  return {
    agent,
    otherAgent,
    user,
    otherUser,
    task,
    sibling,
    foreign,
    concurrent,
    feedback,
    profile,
    resource,
    browser,
  };
}

export async function removeResourceTestDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
}
