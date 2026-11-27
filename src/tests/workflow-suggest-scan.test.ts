import { describe, expect, test } from "bun:test";
import {
  type Ask,
  askTokens,
  findPattern,
  isAlreadyOffered,
} from "../be/seed-scripts/catalog/workflow-suggest-scan";

const ask = (id: string, createdAt: string, task: string): Ask => ({ id, createdAt, task });
const now = ask("t-now", "2026-11-27T10:00:00.000Z", "do a quick release pr for the swarm pls");
const history = [
  ask("t-3", "2026-11-20T09:00:00.000Z", "perform a release pr pls for the swarm"),
  ask("t-3b", "2026-11-20T09:05:00.000Z", "perform a release pr pls for the swarm"),
  ask("t-2", "2026-11-13T09:00:00.000Z", "can u do a release pr in the swarm repo?"),
  ask("t-x", "2026-11-12T09:00:00.000Z", "research how we could integrate ms teams like slack"),
];

describe("workflow-suggest-scan pattern", () => {
  test("strips client scaffolding before tokenizing", () => {
    const tokens = askTokens(
      "<thread_context>\nTaras: unrelated words\n</thread_context>\n\nrelease pr swarm\n\n---\nPage: Feed | LinkedIn\nhttps://x.com/a",
    );
    expect([...tokens].sort()).toEqual(["release", "swarm"]);
  });

  test("similar asks on 3 days make a pattern, a same-day duplicate counts once", () => {
    const pattern = findPattern(now, history, 0.35, 3);
    expect(pattern).not.toBeNull();
    expect(pattern?.count).toBe(3);
    expect(pattern?.id).toBe("t-2");
    expect(pattern?.taskIds).toEqual(["t-now", "t-3", "t-2"]);
    expect(pattern?.cadence).toBe(7);
  });

  test("control: fewer days than repeatMinCount, or a higher similarity bar, is no pattern", () => {
    expect(findPattern(now, history, 0.35, 4)).toBeNull();
    expect(findPattern(now, history, 0.9, 3)).toBeNull();
    expect(findPattern(ask("t-short", now.createdAt, "ping ok"), history, 0.35, 2)).toBeNull();
  });

  test("a ledger record matches by pattern id, shared task, or a reworded sample", () => {
    const pattern = findPattern(now, history, 0.35, 3);
    const byId = [{ key: "u/u1/p/t-2", value: { state: "declined" } }];
    const byTask = [{ key: "u/u1/p/old", value: { taskIds: ["t-3"] } }];
    const bySample = [{ key: "u/u1/p/old", value: { sample: "release pr for the swarm repo" } }];
    const other = [{ key: "u/u1/p/old", value: { sample: "weekly linkedin metrics report" } }];
    expect(isAlreadyOffered(byId, now, pattern, 0.35)).toBe(true);
    expect(isAlreadyOffered(byTask, now, pattern, 0.35)).toBe(true);
    expect(isAlreadyOffered(bySample, now, pattern, 0.35)).toBe(true);
    expect(isAlreadyOffered(other, now, pattern, 0.35)).toBe(false);
  });
});
