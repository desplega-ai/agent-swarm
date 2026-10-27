import { describe, expect, test } from "bun:test";
import type { WhoamiGrants } from "../api/types";
import { canWithGrants, isAdminWithGrants } from "./use-can";

const REQUESTER: WhoamiGrants = {
  grantsAll: false,
  verbs: ["task.create.own", "task.cancel.own", "task.action.own", "task.steer.own"],
  roles: ["requester"],
};
const VIEWER: WhoamiGrants = {
  grantsAll: false,
  verbs: ["favorite.write.own", "session.presence"],
  roles: ["viewer"],
};
const ADMIN: WhoamiGrants = { grantsAll: true, verbs: [], roles: ["admin"] };
const KNOWN = { operatorTab: false, pending: false };

describe("canWithGrants", () => {
  test("an operator-key tab can do everything", () => {
    expect(
      canWithGrants(undefined, "config.write.any", { operatorTab: true, pending: false }),
    ).toBe(true);
    expect(canWithGrants(VIEWER, "task.create.own", { operatorTab: true, pending: false })).toBe(
      true,
    );
  });

  test("a pending whoami shows everything", () => {
    expect(canWithGrants(undefined, "task.create.own", { operatorTab: false, pending: true })).toBe(
      true,
    );
  });

  test("absent grants (older API, failed whoami) show everything", () => {
    expect(canWithGrants(undefined, "config.write.any", KNOWN)).toBe(true);
  });

  test("a Requester holds its verbs", () => {
    expect(canWithGrants(REQUESTER, "task.create.own", KNOWN)).toBe(true);
    expect(canWithGrants(REQUESTER, "task.steer.own", KNOWN)).toBe(true);
  });

  test("a missing verb is denied", () => {
    expect(canWithGrants(REQUESTER, "config.write.any", KNOWN)).toBe(false);
    expect(canWithGrants(VIEWER, "task.create.own", KNOWN)).toBe(false);
  });

  test("grantsAll allows any verb", () => {
    expect(canWithGrants(ADMIN, "config.write.any", KNOWN)).toBe(true);
  });
});

describe("isAdminWithGrants", () => {
  test("unknown grants count as admin", () => {
    expect(isAdminWithGrants(undefined, KNOWN)).toBe(true);
    expect(isAdminWithGrants(VIEWER, { operatorTab: true, pending: false })).toBe(true);
    expect(isAdminWithGrants(VIEWER, { operatorTab: false, pending: true })).toBe(true);
  });

  test("only grantsAll is admin once grants are known", () => {
    expect(isAdminWithGrants(ADMIN, KNOWN)).toBe(true);
    expect(isAdminWithGrants(REQUESTER, KNOWN)).toBe(false);
    expect(isAdminWithGrants(VIEWER, KNOWN)).toBe(false);
  });
});
