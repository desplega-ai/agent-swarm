import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createAgentMailInboxMapping,
  deleteAgentMailInboxMapping,
  getAgentMailInboxMapping,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-agentmail-inbox-mapping.sqlite";

function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

let ownerId = "";
let otherId = "";

beforeEach(async () => {
  removeDbFiles();
  initDb(TEST_DB_PATH);
  ownerId = (await createAgent({ name: "Owner", isLead: false, status: "idle" })).id;
  otherId = (await createAgent({ name: "Other", isLead: false, status: "idle" })).id;
});

afterEach(() => {
  closeDb();
  removeDbFiles();
});

describe("createAgentMailInboxMapping", () => {
  test("maps a free inbox to the caller", async () => {
    const mapping = await createAgentMailInboxMapping("inb_free", ownerId, "free@agentmail.to");
    expect(mapping).toMatchObject({
      inboxId: "inb_free",
      agentId: ownerId,
      inboxEmail: "free@agentmail.to",
    });
  });

  test("the owner registering again keeps the mapping and refreshes the email", async () => {
    const first = await createAgentMailInboxMapping("inb_again", ownerId, "old@agentmail.to");
    const again = await createAgentMailInboxMapping("inb_again", ownerId, "new@agentmail.to");
    expect(again).toMatchObject({
      id: first?.id,
      agentId: ownerId,
      inboxEmail: "new@agentmail.to",
    });
  });

  test("another agent cannot take over a mapped inbox, and nothing changes", async () => {
    await createAgentMailInboxMapping("inb_owned", ownerId, "owned@agentmail.to");
    const taken = await createAgentMailInboxMapping("inb_owned", otherId, "taken@agentmail.to");
    expect(taken).toBeNull();
    expect(await getAgentMailInboxMapping("inb_owned")).toMatchObject({
      agentId: ownerId,
      inboxEmail: "owned@agentmail.to",
    });
  });

  test("a freed inbox can be mapped by another agent", async () => {
    await createAgentMailInboxMapping("inb_freed", ownerId);
    expect(await deleteAgentMailInboxMapping("inb_freed")).toBe(true);
    const mapping = await createAgentMailInboxMapping("inb_freed", otherId);
    expect(mapping?.agentId).toBe(otherId);
  });
});
