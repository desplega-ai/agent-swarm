import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createPage, createUser, deletePage, initDb, updateUser } from "../be/db";
import { type IdentityActor, mintToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { signPageSession } from "../utils/page-session";

const TEST_DB_PATH = `/tmp/test-page-viewer-auth-${Date.now()}.sqlite`;
const API_KEY = "test-page-viewer-auth-key";
let PAGE_ID = "";
const PAGE_AGENT_ID = crypto.randomUUID();
const ACTOR: IdentityActor = { kind: "operator", id: "test" };

function request(headers: Record<string, string>) {
  return { headers } as never;
}

describe("page-session viewer auth", () => {
  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "test-page-viewer-auth-secret";
    initDb(TEST_DB_PATH);
    const page = await createPage({
      agentId: PAGE_AGENT_ID,
      slug: "viewer-auth",
      title: "Viewer auth",
      contentType: "text/html",
      body: "<p>Viewer auth</p>",
    });
    PAGE_ID = page.id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("API-key proxy auth resolves the active user in the signed session", async () => {
    const user = await createUser({ name: "Proxy Viewer" });
    const { plaintext } = await mintToken(user.id, "page-viewer-auth", ACTOR);
    const session = await signPageSession({
      pageId: PAGE_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      uid: user.id,
      name: user.name,
    });

    const auth = await resolveHttpRequestAuth(
      request({
        authorization: `Bearer ${API_KEY}`,
        "x-page-session": session,
        "x-page-id": PAGE_ID,
        "x-agent-id": crypto.randomUUID(),
      }),
      API_KEY,
    );
    expect(auth).toMatchObject({
      kind: "user",
      userId: user.id,
      page: { id: PAGE_ID, executionAgentId: PAGE_AGENT_ID },
    });
    expect(auth?.kind === "user" ? auth.user.name : undefined).toBe("Proxy Viewer");

    // The original user bearer remains a normal user bearer outside the proxy.
    const direct = await resolveHttpRequestAuth(
      request({ authorization: `Bearer ${plaintext}` }),
      API_KEY,
    );
    expect(direct).toMatchObject({ kind: "user", userId: user.id });
    expect(direct?.page).toBeUndefined();

    const forged = await resolveHttpRequestAuth(
      request({
        authorization: `Bearer ${API_KEY}`,
        "x-page-viewer-id": user.id,
        "x-page-viewer-name": user.name,
      }),
      API_KEY,
    );
    expect(forged).toMatchObject({ kind: "operator" });
    expect(forged?.page).toBeUndefined();
  });

  test("guest sessions retain separate page execution context", async () => {
    const session = await signPageSession({
      pageId: PAGE_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      name: "guest-test",
    });
    const auth = await resolveHttpRequestAuth(
      request({
        authorization: `Bearer ${API_KEY}`,
        "x-page-session": session,
        "x-page-id": PAGE_ID,
      }),
      API_KEY,
    );
    expect(auth).toMatchObject({
      kind: "operator",
      page: { id: PAGE_ID, executionAgentId: PAGE_AGENT_ID },
    });
  });

  test("rejects execution context for a deleted page", async () => {
    const page = await createPage({
      agentId: PAGE_AGENT_ID,
      slug: "deleted-viewer-auth",
      title: "Deleted viewer auth",
      contentType: "text/html",
      body: "<p>Deleted</p>",
    });
    const session = await signPageSession({
      pageId: page.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
      name: "guest-test",
    });
    await deletePage(page.id);
    expect(
      await resolveHttpRequestAuth(
        request({
          authorization: `Bearer ${API_KEY}`,
          "x-page-session": session,
          "x-page-id": page.id,
        }),
        API_KEY,
      ),
    ).toBeNull();
  });

  test("rejects a signed session for an inactive user", async () => {
    const user = await createUser({ name: "Suspended Proxy Viewer" });
    await updateUser(user.id, { status: "suspended" });
    const session = await signPageSession({
      pageId: PAGE_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      uid: user.id,
      name: user.name,
    });

    const auth = await resolveHttpRequestAuth(
      request({
        authorization: `Bearer ${API_KEY}`,
        "x-page-session": session,
        "x-page-id": PAGE_ID,
      }),
      API_KEY,
    );
    expect(auth).toBeNull();
  });

  test("rejects malformed, expired, and page-mismatched proxy sessions", async () => {
    const user = await createUser({ name: "Malformed Proxy Viewer" });
    const makeRequest = (session: string, pageId = PAGE_ID) =>
      resolveHttpRequestAuth(
        request({
          authorization: `Bearer ${API_KEY}`,
          "x-page-session": session,
          "x-page-id": pageId,
        }),
        API_KEY,
      );

    expect(await makeRequest("broken.token")).toBeNull();
    const expired = await signPageSession({
      pageId: PAGE_ID,
      exp: Math.floor(Date.now() / 1000) - 1,
      uid: user.id,
      name: user.name,
    });
    expect(await makeRequest(expired)).toBeNull();
    const valid = await signPageSession({
      pageId: PAGE_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      uid: user.id,
      name: user.name,
    });
    expect(await makeRequest(valid, "another-page")).toBeNull();
  });
});
