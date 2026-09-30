import { describe, expect, test } from "bun:test";
// `use-agent-fs.ts` re-exports `pickableMembers`. The hooks module imports
// through "@/", which the root test runner cannot resolve, so the test reads
// the selector from its source module.
import { pickableMembers } from "../../lib/comb/mentions";

const members = [
  { userId: "u-me", email: "me@example.com", displayName: "Me" },
  { userId: "u-bob", email: "bob@example.com", displayName: "Bob" },
  { userId: "u-agent", email: "worker-1@swarm.local", displayName: "Worker 1" },
  { userId: "u-lead", email: "Lead@Swarm.Local", displayName: null },
  { userId: "u-service", email: "swarm-admin@agent-fs.local", displayName: null },
];

describe("pickableMembers", () => {
  test("drops the caller and the swarm's agent accounts", () => {
    expect(pickableMembers(members, "u-me").map((m) => m.userId)).toEqual(["u-bob", "u-service"]);
  });

  test("drops the swarm service account when its id is known", () => {
    expect(pickableMembers(members, "u-me", "u-service").map((m) => m.userId)).toEqual(["u-bob"]);
  });

  test("keeps everyone else without a caller id", () => {
    expect(pickableMembers(members, null).map((m) => m.userId)).toEqual([
      "u-me",
      "u-bob",
      "u-service",
    ]);
  });
});
