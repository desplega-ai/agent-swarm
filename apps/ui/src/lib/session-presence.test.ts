import { describe, expect, test } from "bun:test";
import {
  parseSessionPeer,
  sessionPresenceNamespace,
  sessionViewers,
  typingLabel,
} from "./session-presence";

function raw(connection: string, id: string, name: string, typing = false, extra = {}) {
  return {
    userId: connection,
    kind: "user",
    data: { v: 1, who: { id, name }, typing, t: 1 },
    ...extra,
  };
}

function peers(...entries: unknown[]) {
  return entries.flatMap((entry) => {
    const peer = parseSessionPeer(entry);
    return peer ? [peer] : [];
  });
}

describe("sessionPresenceNamespace", () => {
  test("builds the room for a task id", () => {
    expect(sessionPresenceNamespace("3f54c29d-6fe4-4caa-8320-af3dbd07c468")).toBe(
      "presence:session:3f54c29d-6fe4-4caa-8320-af3dbd07c468",
    );
  });

  test("rejects ids the server would refuse", () => {
    expect(sessionPresenceNamespace("")).toBeNull();
    expect(sessionPresenceNamespace("a:b")).toBeNull();
    expect(sessionPresenceNamespace("x".repeat(65))).toBeNull();
  });
});

describe("parseSessionPeer", () => {
  test("keeps a valid peer and coerces typing to a boolean", () => {
    const peer = parseSessionPeer(raw("c1", "u1", "Eze", "yes" as unknown as boolean));
    expect(peer).toEqual({
      connection: "c1",
      data: { v: 1, who: { id: "u1", name: "Eze" }, typing: false, t: 1 },
    });
  });

  test("drops agents, wrong versions, and peers without a who", () => {
    expect(parseSessionPeer(raw("c1", "u1", "Eze", false, { kind: "agent" }))).toBeNull();
    expect(parseSessionPeer({ userId: "c1", data: { v: 2, who: { id: "u1" }, t: 1 } })).toBeNull();
    expect(parseSessionPeer({ userId: "c1", data: { v: 1, t: 1 } })).toBeNull();
    expect(parseSessionPeer({ userId: "", data: { v: 1, who: { id: "u1" }, t: 1 } })).toBeNull();
  });
});

describe("sessionViewers", () => {
  test("hides my own tabs", () => {
    const viewers = sessionViewers(peers(raw("c1", "me", "Me"), raw("c2", "u1", "Eze")), "me");
    expect(viewers.map((v) => v.id)).toEqual(["u1"]);
  });

  test("folds one person's tabs together; typing in any tab counts", () => {
    const viewers = sessionViewers(
      peers(raw("c1", "u1", "Eze"), raw("c2", "u1", "Eze", true), raw("c3", "u2", "Ana")),
      null,
    );
    expect(viewers.map((v) => [v.name, v.typing])).toEqual([
      ["Ana", false],
      ["Eze", true],
    ]);
  });
});

describe("typingLabel", () => {
  const viewer = (name: string, typing: boolean) => ({ id: name, name, color: 1, typing });

  test("names one or two people, counts more", () => {
    expect(typingLabel([viewer("Eze", false)])).toBeNull();
    expect(typingLabel([viewer("Eze", true)])).toBe("Eze is typing…");
    expect(typingLabel([viewer("Eze", true), viewer("Mar", true)])).toBe("Eze and Mar are typing…");
    expect(
      typingLabel([viewer("A", true), viewer("B", true), viewer("C", true), viewer("D", false)]),
    ).toBe("3 people are typing…");
  });
});
