import { describe, expect, test } from "bun:test";
import { ancestorFolderPaths, buildKeyTree, normalizeFolderPath } from "./memory-key-tree";

const keys = [
  { key: "/longterm/facts/swarm-deploy/worker-sigterm" },
  { key: "/longterm/facts/agenticos/litmus-check-allowlists" },
  { key: "/longterm/decisions/use-bun" },
  { key: "/longterm/entities/people/taras" },
  { key: "/longterm/entities/people/taras" },
  { key: "/longterm/top-level-note" },
  { key: "/notes/outside" },
];

describe("buildKeyTree", () => {
  const root = buildKeyTree(keys, "/longterm/");

  test("folders are path segments, sorted, with descendant counts", () => {
    expect(root.count).toBe(6);
    expect(root.folders.map((f) => [f.name, f.count])).toEqual([
      ["decisions", 1],
      ["entities", 2],
      ["facts", 2],
    ]);
    const facts = root.folders[2];
    expect(facts?.path).toBe("/longterm/facts/");
    expect(facts?.folders.map((f) => f.path)).toEqual([
      "/longterm/facts/agenticos/",
      "/longterm/facts/swarm-deploy/",
    ]);
  });

  test("leaves sit in the folder of their last segment; same-key memories both show", () => {
    expect(root.leaves.map((l) => l.name)).toEqual(["top-level-note"]);
    const people = root.folders[1]?.folders[0];
    expect(people?.leaves.map((l) => l.name)).toEqual(["taras", "taras"]);
  });

  test("keys outside the root are skipped", () => {
    expect(JSON.stringify(root)).not.toContain("/notes/outside");
  });
});

describe("folder paths", () => {
  test("normalize adds slashes", () => {
    expect(normalizeFolderPath("longterm/facts")).toBe("/longterm/facts/");
  });

  test("ancestors run from the root to the folder", () => {
    expect(ancestorFolderPaths("/longterm/", "/longterm/facts/swarm-deploy/")).toEqual([
      "/longterm/",
      "/longterm/facts/",
      "/longterm/facts/swarm-deploy/",
    ]);
    expect(ancestorFolderPaths("/longterm/", "/elsewhere/")).toEqual(["/longterm/"]);
  });
});
