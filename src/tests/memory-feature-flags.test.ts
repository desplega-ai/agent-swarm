import { afterAll, describe, expect, test } from "bun:test";
import { isGraphExpansionEnabled, isHybridSearchEnabled } from "../be/memory/constants";

const previousHybrid = process.env.MEMORY_HYBRID_SEARCH;
const previousGraph = process.env.MEMORY_GRAPH_EXPANSION;

afterAll(() => {
  if (previousHybrid === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
  else process.env.MEMORY_HYBRID_SEARCH = previousHybrid;

  if (previousGraph === undefined) delete process.env.MEMORY_GRAPH_EXPANSION;
  else process.env.MEMORY_GRAPH_EXPANSION = previousGraph;
});

describe("memory retrieval feature flags", () => {
  test("hybrid search defaults on and keeps explicit enable/disable overrides", () => {
    delete process.env.MEMORY_HYBRID_SEARCH;
    expect(isHybridSearchEnabled()).toBe(true);

    for (const enabled of ["", " ", "\t", "1", "true", "TRUE"]) {
      process.env.MEMORY_HYBRID_SEARCH = enabled;
      expect(isHybridSearchEnabled()).toBe(true);
    }

    for (const disabled of ["0", "false", "FALSE", " 0 ", " false "]) {
      process.env.MEMORY_HYBRID_SEARCH = disabled;
      expect(isHybridSearchEnabled()).toBe(false);
    }
  });

  test("graph expansion defaults on and keeps explicit enable/disable overrides", () => {
    delete process.env.MEMORY_GRAPH_EXPANSION;
    expect(isGraphExpansionEnabled()).toBe(true);

    for (const enabled of ["", " ", "\t", "1", "true", "TRUE"]) {
      process.env.MEMORY_GRAPH_EXPANSION = enabled;
      expect(isGraphExpansionEnabled()).toBe(true);
    }

    for (const disabled of ["0", "false", "FALSE", " 0 ", " false "]) {
      process.env.MEMORY_GRAPH_EXPANSION = disabled;
      expect(isGraphExpansionEnabled()).toBe(false);
    }
  });
});
