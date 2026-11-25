import { createHash } from "node:crypto";
import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

export const scriptRunnerCredentials: Scenario = {
  name: "script-runner-credentials",
  order: 498,
  async run(ctx) {
    const path = "/api/script-runners/credentials";
    const body = {
      name: `runner-${ctx.nonce}`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const user = await ctx.api("POST", "/api/users", {
      body: { name: `runner-user-${ctx.nonce}`, status: "active" },
    });
    expectStatus(user, [200], "create user with the default admin role");
    const userId = asString(asRecord(asRecord(user.json).user).id, "user id");
    const userToken = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, { body: {} });
    expectStatus(userToken, [200], "mint user token");
    const apiKey = asString(asRecord(userToken.json).plaintext, "user token");
    for (const [method, target] of [
      ["GET", path],
      ["POST", path],
      ["DELETE", `${path}/missing`],
    ] as const) {
      expectStatus(
        await ctx.api(method, target, { apiKey, body: method === "POST" ? body : undefined }),
        [403],
        "default admin lacks the explicit runner grant",
      );
      expectStatus(
        await ctx.api(method, target, { apiKey: null, body: method === "POST" ? body : undefined }),
        [401],
        "anonymous denied",
      );
    }
    const agents = await ctx.api("GET", "/api/agents");
    expectStatus(agents, [200], "read disposable harness agent");
    const agentId = asString(asRecords(agents.json, "agents")[0]?.id, "agent id");
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expectStatus(
        await ctx.api(method, method === "DELETE" ? `${path}/missing` : path, {
          agentId,
          body: method === "POST" ? body : undefined,
        }),
        [403],
        "agent principal denied",
      );
    }
    expectStatus(
      await ctx.api("POST", path, { body: { ...body, expiresAt: "2000-01-01T00:00:00.000Z" } }),
      [400],
      "expired mint refused",
    );
    expectStatus(
      await ctx.api("POST", path, { body: { ...body, expiresAt: "9999-01-01T00:00:00.000Z" } }),
      [400],
      "refuse a credential beyond the maximum lifetime",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${userId}/roles`, {
        body: { roles: ["admin", "script-runner-manager"] },
      }),
      [200],
      "operator grants runner management",
    );
    let id: string | undefined;
    try {
      const authorized = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, { body: {} });
      expectStatus(authorized, [200], "mint a credential after the role grant");
      const authorizedKey = asString(asRecord(authorized.json).plaintext, "authorized user token");
      const minted = await ctx.api("POST", path, {
        apiKey: authorizedKey,
        body: { name: body.name },
      });

      expectStatus(minted, [ctx.db.engine === "sqlite" ? 409 : 201], "engine capability gate");
      if (ctx.db.engine === "sqlite") {
        expect(minted.text.includes("script_runners_need_postgres"), "SQLite refusal code");
        expectStatus(await ctx.api("GET", path), [200], "SQLite list");
        expectStatus(await ctx.api("DELETE", `${path}/missing`), [404], "SQLite revoke missing");
        return;
      }
      expectStatus(minted, [201], "mint runner credential");
      const token = asString(asRecord(minted.json).token, "runner token");
      const credential = asRecord(asRecord(minted.json).credential);
      id = asString(credential.id, "credential id");
      expect(
        minted.headers.get("cache-control") === "no-store",
        "single-use response cannot be cached",
      );
      expect(credential.createdBy === userId, "credential records its issuer");
      expect(/^assr_[a-f0-9]{64}$/.test(token), "runner token shape");
      const stored = ctx.db.get<{ token_hash: string }>(
        sql`SELECT token_hash FROM script_runner_credentials WHERE id = ${id}`,
      );
      expect(
        stored?.token_hash === createHash("sha256").update(token).digest("hex"),
        "only hash persisted",
      );
      const listed = await ctx.api("GET", path);
      expectStatus(listed, [200], "list credentials");
      expect(
        asRecords(listed.json, "credentials").some((row) => row.id === id),
        "credential listed",
      );
      expect(
        !listed.text.includes(token) &&
          !listed.text.includes(String(stored?.token_hash)) &&
          !/token/i.test(listed.text),
        "list contains no token material",
      );
      for (const target of ["/api/whoami", path, "/api/tasks"]) {
        expectStatus(
          await ctx.api("GET", target, { apiKey: token }),
          [401],
          "runner token cannot authenticate HTTP",
        );
      }
      expectStatus(await ctx.api("DELETE", `${path}/${id}`), [200], "revoke credential");
      const revoked = await ctx.api("GET", path);
      expect(
        asRecords(revoked.json, "credentials").find((row) => row.id === id)?.revokedAt != null,
        "revocation persists",
      );
      expectStatus(
        await ctx.api("GET", path, { apiKey: token }),
        [401],
        "revoked token cannot authenticate HTTP",
      );
      const sessionId = `runner-scrub-${ctx.nonce}`;
      const logged = await ctx.api("POST", "/api/session-logs", {
        body: {
          sessionId,
          iteration: 1,
          cli: "claude",
          lines: [JSON.stringify({ output: `Bearer ${token}` })],
        },
      });
      expectStatus(logged, [201], "persist token through existing log ingress");
      const logs = ctx.db.query<{ content: string }>(
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${sessionId}`,
      );
      expect(
        logs.length === 1 &&
          !logs[0].content.includes(token) &&
          logs[0].content.includes("[REDACTED:"),
        "stored log scrubs revoked token",
      );
      expect(!(await ctx.sutLog()).includes(token), "SUT never logs raw token");
    } finally {
      if (id)
        expectStatus(await ctx.api("DELETE", `${path}/${id}`), [200], "revoke fixture credential");
      expectStatus(
        await ctx.api("PUT", `/api/users/${userId}/roles`, { body: { roles: ["admin"] } }),
        [200],
        "remove runner grant",
      );
    }
  },
};
