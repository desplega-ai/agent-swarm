import { describe, expect, test } from "bun:test";
import { isBlockOpen, type StepBlocks, syncHandoffs, toggleBlock } from "./use-step-blocks";

const EMPTY: StepBlocks = { opened: new Set(), shut: new Set() };

/** What the pane does: render with `handoffs`, then sync before paint. */
const show = (blocks: StepBlocks, handoffs: boolean) => syncHandoffs(blocks, handoffs);

describe("step blocks", () => {
  test("Handoffs Off keeps the blocks a person opened, per part", () => {
    let blocks = show(EMPTY, false);
    blocks = toggleBlock(blocks, "a", false);
    expect(isBlockOpen(blocks, "a", false)).toBe(true);
    expect(isBlockOpen(blocks, "b", false)).toBe(false);
  });

  test("Handoffs On opens every block, and a close lasts only for that On period", () => {
    let blocks = show(EMPTY, true);
    expect(isBlockOpen(blocks, "a", true)).toBe(true);
    blocks = toggleBlock(blocks, "a", true);
    expect(isBlockOpen(blocks, "a", true)).toBe(false);
    // Off brings back the per-part state; On again opens every block.
    blocks = show(blocks, false);
    expect(isBlockOpen(blocks, "a", false)).toBe(false);
    expect(isBlockOpen(blocks, "a", true)).toBe(true);
    blocks = show(blocks, true);
    expect(isBlockOpen(blocks, "a", true)).toBe(true);
  });

  test("the first render after a change already ignores the old closes", () => {
    let blocks = show(EMPTY, true);
    blocks = toggleBlock(blocks, "a", true);
    blocks = show(blocks, false);
    // Rendered with On before the sync runs.
    expect(isBlockOpen(blocks, "a", true)).toBe(true);
  });

  test("closes made while On survive a remount in the same On period", () => {
    const blocks = toggleBlock(show(EMPTY, true), "a", true);
    expect(isBlockOpen(show(blocks, true), "a", true)).toBe(false);
  });
});
