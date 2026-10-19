import { describe, expect, test } from "bun:test";
import type { SessionShares } from "../api/types";
import {
  addPerson,
  isReadOnlyAccess,
  setEveryone,
  setPerson,
  sharesInput,
} from "./session-sharing";

const base: SessionShares = {
  everyone: "none",
  users: [{ userId: "eze", access: "write", createdAt: "2026-10-18T10:00:00.000Z" }],
};

describe("isReadOnlyAccess", () => {
  test("only an explicit read locks the composer", () => {
    expect(isReadOnlyAccess("read")).toBe(true);
    expect(isReadOnlyAccess("write")).toBe(false);
    expect(isReadOnlyAccess("owner")).toBe(false);
    // Older servers omit `access`: the composer stays as today.
    expect(isReadOnlyAccess(undefined)).toBe(false);
  });
});

describe("share state helpers", () => {
  test("a new person lands at Can view", () => {
    expect(addPerson(base, "mar", "taras").users).toEqual([
      base.users[0],
      { userId: "mar", access: "read" },
    ]);
  });

  test("adding the owner or someone already added changes nothing", () => {
    expect(addPerson(base, "taras", "taras")).toBe(base);
    expect(addPerson(base, "eze", "taras")).toBe(base);
  });

  test("changes and removes a person", () => {
    expect(setPerson(base, "eze", "read").users[0].access).toBe("read");
    expect(setPerson(base, "eze", "remove").users).toEqual([]);
  });

  test("sets general access and builds the PUT body without timestamps", () => {
    const next = setEveryone(base, "read");
    expect(sharesInput(next)).toEqual({
      everyone: "read",
      users: [{ userId: "eze", access: "write" }],
    });
  });
});
