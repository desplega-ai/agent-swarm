import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewUser, type Storage, sql, type UsersRepository } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function newUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    id: crypto.randomUUID().replace(/-/g, ""),
    name: "User",
    email: null,
    role: null,
    notes: null,
    emailAliases: "[]",
    preferredChannel: "slack",
    timezone: null,
    metadata: null,
    dailyBudgetUsd: null,
    status: "active",
    avatar: null,
    now: T0,
    ...overrides,
  };
}

export function usersContract(engine: ContractEngine): void {
  describe(`users repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: UsersRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.users;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("user rows keep the stored value shape", async () => {
      const row = await repo.insertUser(
        newUser({
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          emailAliases: '["a@x.io"]',
          metadata: '{"k":1}',
          dailyBudgetUsd: 2.5,
          status: "invited",
          avatar: '{"kind":"initials"}',
        }),
      );
      expect(row).toMatchObject({
        id: "u1",
        name: "Ada",
        email: "ada@example.com",
        role: null,
        notes: null,
        emailAliases: '["a@x.io"]',
        preferredChannel: "slack",
        timezone: null,
        metadata: '{"k":1}',
        dailyBudgetUsd: 2.5,
        status: "invited",
        mergedIntoUserId: null,
        avatar: '{"kind":"initials"}',
        createdAt: T0,
        lastUpdatedAt: T0,
      });
      expect(await repo.findUserById("u1")).toEqual(row);
      expect(await repo.findUserById("missing")).toBeNull();
      expect(await repo.userExists("u1")).toBe(true);
      expect(await repo.userExists("missing")).toBe(false);
    });

    test("updateUser sets only the given columns, and null when the row is missing", async () => {
      await repo.insertUser(newUser({ id: "u1", name: "Ada", role: "eng", timezone: "UTC" }));
      const row = await repo.updateUser("u1", { name: "Ada L", email: null, metadata: null }, T1);
      expect(row).toMatchObject({ name: "Ada L", role: "eng", timezone: "UTC", lastUpdatedAt: T1 });
      expect(await repo.updateUser("missing", { name: "x" }, T1)).toBeNull();
    });

    test("conditional user writes", async () => {
      await repo.insertUser(newUser({ id: "u1", status: "invited" }));
      await repo.insertUser(newUser({ id: "u2", timezone: "Europe/Madrid" }));
      expect(await repo.activateInvitedUser("u1", T1)).toBe(1);
      expect(await repo.activateInvitedUser("u1", T2)).toBe(0);
      expect(await repo.findUserById("u1")).toMatchObject({ status: "active", lastUpdatedAt: T1 });

      await repo.fillMissingTimezone("u1", "UTC", T2);
      await repo.fillMissingTimezone("u2", "UTC", T2);
      expect((await repo.findUserById("u1"))?.timezone).toBe("UTC");
      expect(await repo.findUserById("u2")).toMatchObject({
        timezone: "Europe/Madrid",
        lastUpdatedAt: T0,
      });

      await repo.markUserMergedInto("u1", "u2", T2);
      expect((await repo.findUserById("u1"))?.mergedIntoUserId).toBe("u2");
      expect(await repo.deleteUser("u1")).toBe(1);
      expect(await repo.deleteUser("u1")).toBe(0);
    });

    test("user lists: name order with insertion-order ties, ASCII case folds", async () => {
      await repo.insertUser(newUser({ id: "c", name: "bob", emailAliases: '["x@y.z"]' }));
      await repo.insertUser(newUser({ id: "a", name: "Bob", email: "BOB@Example.com" }));
      await repo.insertUser(newUser({ id: "b", name: "bob", emailAliases: '["q@y.z"]' }));
      await repo.insertUser(newUser({ id: "d", name: "Bobby Tables" }));
      await repo.insertUser(newUser({ id: "e", name: "bob", emailAliases: '["m@y.z"]' }));
      await repo.markUserMergedInto("e", "a", T1);

      // Byte order: uppercase before lowercase.
      expect((await repo.listUsers()).map((r) => r.id)).toEqual(["a", "d", "c", "b", "e"]);
      expect((await repo.listUsersByName("BOB")).map((r) => r.id)).toEqual(["c", "a", "b"]);
      expect((await repo.listUsersByNamePrefix("bOb")).map((r) => r.id)).toEqual([
        "c",
        "a",
        "b",
        "d",
      ]);
      expect((await repo.listUsersWithEmailAliases()).map((r) => r.id)).toEqual(["c", "b"]);
      expect((await repo.findUserByPrimaryEmail("bob@example.COM"))?.id).toBe("a");
      await repo.insertUser(newUser({ id: "a2", name: "x", email: "bob@example.com" }));
      expect((await repo.findUserByPrimaryEmail("BOB@EXAMPLE.COM"))?.id).toBe("a");
      await repo.markUserMergedInto("a", "c", T1);
      expect((await repo.findUserByPrimaryEmail("bob@example.com"))?.id).toBe("a2");
      await repo.markUserMergedInto("a2", "c", T1);
      expect(await repo.findUserByPrimaryEmail("bob@example.com")).toBeNull();
    });

    test("job function, org domain candidates and snapshot counts", async () => {
      await repo.insertUser(newUser({ id: "u1", metadata: '{"jobFunction":"eng"}' }));
      // A NULL metadata stands for an unreadable one: json_valid(NULL) drops the row on SQLite,
      // and jsonb cannot hold invalid JSON (the data copy reports such values instead).
      await repo.insertUser(newUser({ id: "u2", metadata: null }));
      await repo.insertUser(newUser({ id: "u3", metadata: '{"other":1}' }));
      expect(await repo.getUserJobFunction("u1")).toBe("eng");
      expect(await repo.getUserJobFunction("u2")).toBeUndefined();
      expect(await repo.getUserJobFunction("u3")).toBeNull();
      expect(await repo.getUserJobFunction("missing")).toBeUndefined();

      // Migration 109's trigger attaches the grant-all admin role to every new user.
      await repo.insertUser(newUser({ id: "m2", email: "m@b.io", now: T1 }));
      await repo.insertUser(newUser({ id: "m1", email: "m@a.io", now: T1 }));
      await repo.insertUser(newUser({ id: "old", email: "o@c.io", now: T0 }));
      await repo.insertUser(newUser({ id: "blank", email: "  ", now: T0 }));
      await repo.insertUser(newUser({ id: "off", email: "s@d.io", status: "suspended" }));
      await storage.executor.run(
        sql`DELETE FROM principal_roles WHERE "principalId" = 'old' AND "principalType" = 'user'`,
      );
      expect(await repo.listOrgDomainCandidateEmails(20)).toEqual(["m@a.io", "m@b.io", "o@c.io"]);
      expect(await repo.listOrgDomainCandidateEmails(1)).toEqual(["m@a.io"]);

      await repo.insertUserToken({
        id: "t1",
        userId: "u1",
        label: null,
        tokenHash: "h1",
        tokenPreview: "t1",
        createdAt: T0,
        expiresAt: null,
      });
      await repo.insertExternalId("u1", "slack", "S1");
      await repo.insertExternalId("u1", "slack", "S2");
      await repo.insertExternalId("u2", "discord", "D1");
      await repo.insertExternalId("off", "slack", "S3");
      expect(await repo.countUsersByStatus("active")).toBe(7);
      expect(await repo.countUsersByStatus("suspended")).toBe(1);
      expect(await repo.countActiveGrantAllUsers()).toBe(6);
      // u1 by token; m1, m2, old by email.
      expect(await repo.countActiveUsersWithLogin()).toBe(4);
      expect(await repo.countActiveUsersLinked("slack")).toBe(1);
      expect(await repo.countActiveUsersLinkedOutside(["slack", "github"])).toBe(1);
      expect(await repo.countActiveUsersLinkedOutside([])).toBe(2);
    });

    test("external ids: lookup, primary-key conflict and order", async () => {
      await repo.insertUser(newUser({ id: "u1" }));
      await repo.insertExternalId("u1", "slack", "U2");
      await repo.insertExternalId("u1", "github", "z");
      await repo.insertExternalId("u1", "slack", "U1");
      await expect(repo.insertExternalId("u1", "slack", "U1")).rejects.toThrow();
      expect((await repo.findUserByExternalId("slack", "U2"))?.id).toBe("u1");
      expect(await repo.findUserByExternalId("slack", "none")).toBeNull();
      expect(await repo.listExternalIds("u1")).toEqual([
        { kind: "github", externalId: "z" },
        { kind: "slack", externalId: "U1" },
        { kind: "slack", externalId: "U2" },
      ]);
      await repo.deleteExternalId("u1", "slack", "U1");
      expect((await repo.listExternalIds("u1")).length).toBe(2);
    });

    test("identity events: newest first, ties newest insert first, cursor and limit", async () => {
      await repo.insertUser(newUser({ id: "u1" }));
      const event = (id: string, createdAt: string) =>
        repo.insertIdentityEvent({
          id,
          userId: "u1",
          eventType: "email_added",
          actor: "system:test",
          beforeJson: null,
          afterJson: `{"id":"${id}"}`,
          createdAt,
        });
      await event("e1", T0);
      await event("e3", T1);
      await event("e2", T1);
      await event("e4", T2);
      const all = await repo.listIdentityEvents("u1", { before: null, limit: 10 });
      expect(all.map((e) => e.id)).toEqual(["e4", "e2", "e3", "e1"]);
      expect(all[0]).toEqual({
        id: "e4",
        userId: "u1",
        eventType: "email_added",
        actor: "system:test",
        beforeJson: null,
        afterJson: '{"id":"e4"}',
        createdAt: T2,
      });
      expect(
        (await repo.listIdentityEvents("u1", { before: T2, limit: 2 })).map((e) => e.id),
      ).toEqual(["e2", "e3"]);
    });

    test("batched list reads match the per-user reads, grouped by user", async () => {
      await repo.insertUser(newUser({ id: "u1" }));
      await repo.insertUser(newUser({ id: "u2" }));
      await repo.insertUser(newUser({ id: "u3" }));
      for (const [userId, kind, externalId] of [
        ["u2", "slack", "S2"],
        ["u1", "slack", "S1"],
        ["u1", "github", "g1"],
      ] as const) {
        await repo.insertExternalId(userId, kind, externalId);
      }
      // Same createdAt on purpose: the tiebreak must match listIdentityEvents.
      for (const [id, userId, createdAt] of [
        ["e1", "u1", T0],
        ["e2", "u1", T1],
        ["e3", "u1", T1],
        ["e4", "u2", T2],
        ["e5", "u1", T2],
      ] as const) {
        await repo.insertIdentityEvent({
          id,
          userId,
          eventType: "email_added",
          actor: "system:test",
          beforeJson: null,
          afterJson: null,
          createdAt,
        });
      }
      for (const [id, userId, createdAt, expiresAt] of [
        ["t1", "u1", T0, null],
        ["t2", "u2", T1, null],
        ["t3", "u1", T0, null],
        ["t4", "u1", T1, null],
        ["run", "u1", T2, "2999-01-01T00:00:00.000Z"],
      ] as const) {
        await repo.insertUserToken({
          id,
          userId,
          label: null,
          tokenHash: `hash-${id}`,
          tokenPreview: id,
          createdAt,
          expiresAt,
        });
      }
      const ids = ["u1", "u2", "u3"];
      const byUser = <T extends { userId: string }>(rows: T[], userId: string) =>
        rows.filter((r) => r.userId === userId);

      const externalIds = await repo.listExternalIdsForUsers(ids);
      const events = await repo.listRecentIdentityEventsForUsers(ids, 2);
      const tokens = await repo.listUserTokensForUsers(ids);
      for (const userId of ids) {
        expect(
          byUser(externalIds, userId).map(({ kind, externalId }) => ({ kind, externalId })),
        ).toEqual(await repo.listExternalIds(userId));
        expect(byUser(events, userId)).toEqual(
          await repo.listIdentityEvents(userId, { before: null, limit: 2 }),
        );
        expect(byUser(tokens, userId)).toEqual(await repo.listUserTokens(userId));
      }
      expect(events.map((e) => e.id)).toEqual(["e5", "e3", "e4"]);
      expect(tokens.map((t) => t.id)).toEqual(["t4", "t1", "t3", "t2"]);
      expect(await repo.listRecentIdentityEventsForUsers(ids, 0)).toEqual([]);
      expect(await repo.listExternalIdsForUsers([])).toEqual([]);
      expect(await repo.listRecentIdentityEventsForUsers([], 5)).toEqual([]);
      expect(await repo.listUserTokensForUsers([])).toEqual([]);
    });

    test("user tokens: lists, revoke paths and liveness", async () => {
      await repo.insertUser(newUser({ id: "u1" }));
      const token = (id: string, createdAt: string, expiresAt: string | null) =>
        repo.insertUserToken({
          id,
          userId: "u1",
          label: id === "t1" ? null : `label-${id}`,
          tokenHash: `hash-${id}`,
          tokenPreview: id.slice(-4),
          createdAt,
          expiresAt,
        });
      await token("t2", T0, null);
      await token("t1", T1, null);
      await token("t3", T0, null);
      await token("run", T2, "2999-01-01T00:00:00.000Z");

      expect((await repo.listUserTokens("u1")).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
      expect((await repo.listUserTokens("u1"))[0]).toEqual({
        id: "t1",
        userId: "u1",
        label: null,
        tokenPreview: "t1",
        createdAt: T1,
        lastUsedAt: null,
        revokedAt: null,
      });
      expect((await repo.listUnrevokedUserTokens("u1")).map((t) => t.id)).toEqual([
        "t2",
        "t1",
        "t3",
        "run",
      ]);
      expect(await repo.findUserTokenSummary("t2")).toEqual({
        userId: "u1",
        label: "label-t2",
        tokenPreview: "t2",
      });
      expect(await repo.findUserTokenByHash("hash-t2")).toEqual({
        id: "t2",
        userId: "u1",
        revokedAt: null,
        expiresAt: null,
      });

      await repo.touchUserToken("t2", T1);
      expect((await repo.listUserTokens("u1")).find((t) => t.id === "t2")?.lastUsedAt).toBe(T1);

      expect(await repo.isLiveUserToken("t2", "u1", T2)).toBe(true);
      expect(await repo.isLiveUserToken("t2", "other", T2)).toBe(false);
      expect(await repo.isLiveUserToken("run", "u1", T2)).toBe(true);
      expect(await repo.isLiveUserToken("run", "u1", "3000-01-01T00:00:00.000Z")).toBe(false);

      // Only a token with an expiry is revoked by revokeExpiringUserToken.
      await repo.revokeExpiringUserToken("t2", T2);
      await repo.revokeExpiringUserToken("run", T2);
      expect((await repo.findUserTokenByHash("hash-t2"))?.revokedAt).toBeNull();
      expect((await repo.findUserTokenByHash("hash-run"))?.revokedAt).toBe(T2);
      await repo.revokeExpiringUserToken("run", "2026-12-01T00:00:00.000Z");
      expect((await repo.findUserTokenByHash("hash-run"))?.revokedAt).toBe(T2);

      await repo.setUserTokenRevoked("t2", T1);
      expect(await repo.isLiveUserToken("t2", "u1", T2)).toBe(false);
      expect((await repo.listUnrevokedUserTokens("u1")).map((t) => t.id)).toEqual(["t1", "t3"]);
    });

    test("connector codes: redeem once per kind, spend, delete", async () => {
      await repo.insertUser(newUser({ id: "u1" }));
      const code = (hash: string, kind: string, expiresAt: string) =>
        repo.insertConnectorCode({
          codeHash: hash,
          userId: "u1",
          label: "L",
          actorKind: "operator",
          actorId: "op",
          createdAt: T0,
          expiresAt,
          kind,
        });
      await code("c1", "connector", T2);
      await code("i1", "invite", T2);
      await code("i2", "invite", T2);
      await code("old", "connector", T0);

      expect(await repo.redeemConnectorCode("c1", "invite", T1)).toBeNull();
      expect(await repo.redeemConnectorCode("c1", "connector", T1)).toEqual({
        user_id: "u1",
        label: "L",
        actor_kind: "operator",
        actor_id: "op",
      });
      expect(await repo.redeemConnectorCode("c1", "connector", T1)).toBeNull();
      expect(await repo.redeemConnectorCode("old", "connector", T1)).toBeNull();
      expect(await repo.redeemConnectorCode("i1", "invite", T2)).toBeNull();

      await repo.spendUnusedConnectorCodes("u1", T1);
      expect(await repo.redeemConnectorCode("i1", "invite", T1)).toBeNull();
      expect(await repo.deleteUnusedInviteCodes("u1")).toBe(0);
      await code("i3", "invite", T2);
      expect(await repo.deleteUnusedInviteCodes("u1")).toBe(1);
      expect(await repo.deleteConnectorCodesExpiredBefore(T1)).toBe(1);
      expect(await repo.deleteConnectorCodesExpiredBefore(T1)).toBe(0);
    });

    test("merge jobs: shape, orders with ties, claim and state writes", async () => {
      const job = (id: string, createdAt: string, src = "s", dst = "t") =>
        repo.insertMergeJob({
          id,
          sourceUserId: src,
          targetUserId: dst,
          createdAt,
          createdBy: null,
        });
      const first = await job("j2", T0);
      expect(first).toEqual({
        id: "j2",
        sourceUserId: "s",
        targetUserId: "t",
        status: "pending",
        phase: null,
        progress: "{}",
        error: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: T0,
        startedAt: null,
        finishedAt: null,
        created_by: null,
        updated_by: null,
      });
      await job("j1", T0);
      await job("j3", T1, "x", "y");
      expect((await repo.listMergeJobs({ status: null, limit: 10 })).map((j) => j.id)).toEqual([
        "j3",
        "j2",
        "j1",
      ]);
      expect((await repo.listMergeJobs({ status: "pending", limit: 2 })).map((j) => j.id)).toEqual([
        "j3",
        "j2",
      ]);
      expect((await repo.findActiveMergeJob("t"))?.id).toBe("j2");
      expect(await repo.findActiveMergeJob("nobody")).toBeNull();

      const claimed = await repo.claimNextMergeJob(T1);
      expect(claimed).toMatchObject({ id: "j2", status: "running", attempts: 1, startedAt: T1 });
      await repo.saveMergeJobProgress("j2", "users.created_by", '{"a":1}');
      await repo.scheduleMergeJobRetry("j2", "boom", T2);
      // j2 waits out its backoff; j1 is next.
      expect((await repo.claimNextMergeJob(T1))?.id).toBe("j1");
      expect((await repo.claimNextMergeJob(T0))?.id).toBe("j3");
      expect(await repo.claimNextMergeJob(T1)).toBeNull();
      const again = await repo.claimNextMergeJob(T2);
      expect(again).toMatchObject({
        id: "j2",
        attempts: 2,
        startedAt: T1,
        phase: "users.created_by",
        progress: '{"a":1}',
        error: "boom",
        nextAttemptAt: null,
      });

      await repo.markMergeJobFailed("j2", "dead", T2);
      await job("j4", T2);
      await repo.markMergeJobFailed("j4", "dead", T2);
      expect((await repo.findFailedMergeJob("s", "t"))?.id).toBe("j4");
      expect(await repo.requeueFailedMergeJob("j1")).toBeNull();
      expect(await repo.requeueFailedMergeJob("j2")).toMatchObject({
        status: "pending",
        error: null,
        attempts: 0,
        finishedAt: null,
      });

      await repo.markMergeJobDone("j3", "delete-user", '{"delete-user":1}', T2);
      expect(await repo.findMergeJob("j3")).toMatchObject({
        status: "done",
        phase: "delete-user",
        finishedAt: T2,
      });

      // j1 running, j2 pending: both pending after a reset.
      await repo.scheduleMergeJobRetry("j2", "e", T2);
      expect(await repo.resetInterruptedMergeJobs()).toBe(2);
      expect(await repo.countPendingMergeJobs()).toBe(2);
      expect(await repo.findMergeJob("j2")).toMatchObject({ nextAttemptAt: null });
    });

    test("app user config upserts by (appId, scope)", async () => {
      await storage.executor.run(sql`
        INSERT INTO apps (id, name, definition, created_at, updated_at)
        VALUES ('app1', 'App', '{}', ${T0}, ${T0})`);
      expect(await repo.getAppUserConfigValues("app1", "user:u1")).toBeNull();
      await repo.upsertAppUserConfigValues({
        id: "c1",
        appId: "app1",
        scope: "user:u1",
        values: '{"a":1}',
        now: T0,
      });
      await repo.upsertAppUserConfigValues({
        id: "c2",
        appId: "app1",
        scope: "user:u1",
        values: '{"a":2}',
        now: T1,
      });
      expect(await repo.getAppUserConfigValues("app1", "user:u1")).toBe('{"a":2}');
      const row = await storage.executor.get(
        sql`SELECT id, "createdAt", "updatedAt" FROM app_user_config WHERE "appId" = 'app1'`,
      );
      expect(row).toEqual({ id: "c1", createdAt: T0, updatedAt: T1 });
    });

    test("favorites: upsert keeps the first row, list orders and ties", async () => {
      const star = (itemType: string, itemId: string, now: string, actor = "a") =>
        repo.upsertFavorite({
          favoriteScope: "user:u",
          userId: null,
          itemType,
          itemId,
          actor,
          now,
        });
      const first = await star("page", "p2", T0);
      expect(first).toMatchObject({
        favoriteScope: "user:u",
        userId: null,
        itemType: "page",
        itemId: "p2",
        createdAt: T0,
        lastUpdatedAt: T0,
        created_by: "a",
        updated_by: "a",
      });
      await star("workflow", "w1", T0);
      await star("page", "p3", T0);
      await star("page", "p1", T0);
      await star("page", "p9", T1);
      const again = await star("page", "p2", T0, "b");
      expect(again).toMatchObject({ id: first?.id, created_by: "a", updated_by: "b" });

      expect((await repo.listFavorites({ favoriteScope: "user:u" })).map((f) => f.itemId)).toEqual([
        "p9",
        "p2",
        "p3",
        "p1",
        "w1",
      ]);
      expect(
        (await repo.listFavorites({ favoriteScope: "user:u", itemType: "page" })).map(
          (f) => f.itemId,
        ),
      ).toEqual(["p9", "p2", "p3", "p1"]);
      expect(
        (
          await repo.listFavorites({
            favoriteScope: "user:u",
            itemType: "page",
            itemIds: ["p3", "p2", "p1"],
          })
        ).map((f) => f.itemId),
      ).toEqual(["p1", "p2", "p3"]);

      await repo.deleteFavorite("user:u", "page", "p2");
      expect(
        (await repo.listFavorites({ favoriteScope: "user:u", itemIds: ["p2", "p3"] })).map(
          (f) => f.itemId,
        ),
      ).toEqual(["p3"]);
    });

    test("listUserEmails returns the non-null emails ordered by email", async () => {
      await repo.insertUser(newUser({ id: "e1", name: "One", email: "zz@x.co" }));
      await repo.insertUser(newUser({ id: "e2", name: "Two", email: "aa@x.co" }));
      await repo.insertUser(newUser({ id: "e3", name: "Three", email: null }));
      expect(await repo.listUserEmails()).toEqual(["aa@x.co", "zz@x.co"]);
    });
  });
}
