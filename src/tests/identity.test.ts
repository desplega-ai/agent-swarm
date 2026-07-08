import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, initDb } from "../be/db";
import { renderIdentity, resolveIdentity, resolveIdentityByEmail } from "../be/identity";
import { type IdentityActor, linkIdentity } from "../be/users";

const TEST_DB_PATH = "./test-identity.sqlite";

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test" };

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("resolveIdentity", () => {
  test("resolved: linked (kind, externalId) returns the user", () => {
    const user = createUser({ name: "Luis", email: "luis@example.com" });
    linkIdentity(user.id, "slack", "U016H7XKZGS", SYSTEM_ACTOR);

    const resolution = resolveIdentity("slack", "U016H7XKZGS");
    expect(resolution).toEqual({
      status: "resolved",
      kind: "slack",
      externalId: "U016H7XKZGS",
      userId: user.id,
      name: "Luis",
      email: "luis@example.com",
    });
  });

  test("unknown: unlinked (kind, externalId) returns the sentinel value, never a name", () => {
    const resolution = resolveIdentity("slack", "U_DOES_NOT_EXIST");
    expect(resolution).toEqual({
      status: "unknown",
      kind: "slack",
      externalId: "U_DOES_NOT_EXIST",
    });
  });

  test("is provider-agnostic — any kind string works identically", () => {
    const user = createUser({ name: "Jira Reporter", email: "jira-reporter@example.com" });
    linkIdentity(user.id, "jira", "5b10a2844c20165700ede21g", SYSTEM_ACTOR);

    const resolution = resolveIdentity("jira", "5b10a2844c20165700ede21g");
    expect(resolution.status).toBe("resolved");
    expect(resolution.status === "resolved" && resolution.userId).toBe(user.id);
  });
});

describe("resolveIdentityByEmail", () => {
  test("resolved: known email returns the user with kind 'email'", () => {
    const user = createUser({ name: "Alberto", email: "alberto@example.com" });

    const resolution = resolveIdentityByEmail("alberto@example.com");
    expect(resolution).toEqual({
      status: "resolved",
      kind: "email",
      externalId: "alberto@example.com",
      userId: user.id,
      name: "Alberto",
      email: "alberto@example.com",
    });
  });

  test("unknown: unregistered email returns the sentinel value", () => {
    const resolution = resolveIdentityByEmail("nobody@example.com");
    expect(resolution).toEqual({
      status: "unknown",
      kind: "email",
      externalId: "nobody@example.com",
    });
  });
});

describe("renderIdentity", () => {
  test("resolved renders 'Name (kind:externalId)'", () => {
    const rendered = renderIdentity({
      status: "resolved",
      kind: "slack",
      externalId: "U016H7XKZGS",
      userId: "u1",
      name: "Luis",
    });
    expect(rendered).toBe("Luis (slack:U016H7XKZGS)");
  });

  test("unknown renders 'kind:externalId (unknown user)' — the sentinel never contains a name", () => {
    const rendered = renderIdentity({
      status: "unknown",
      kind: "slack",
      externalId: "U016H7XKZGS",
    });
    expect(rendered).toBe("slack:U016H7XKZGS (unknown user)");
    expect(rendered).not.toContain("Luis");
  });

  test("the sentinel is deterministic for the same input", () => {
    const resolution = resolveIdentity("github", "octocat-unlinked");
    expect(renderIdentity(resolution)).toBe(renderIdentity(resolution));
    expect(renderIdentity(resolution)).toBe("github:octocat-unlinked (unknown user)");
  });
});
