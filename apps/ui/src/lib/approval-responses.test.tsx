import { describe, expect, test } from "bun:test";
import type { ApprovalQuestion } from "../api/types";
import { missingRequiredResponseIds } from "./approval-responses";

describe("missingRequiredResponseIds", () => {
  test("blocks submission when a required text response is empty", () => {
    const questions: ApprovalQuestion[] = [
      {
        id: "reason",
        type: "text",
        label: "Reason",
        required: true,
        multiline: true,
      },
    ];

    expect(missingRequiredResponseIds(questions, { reason: "   " })).toEqual(["reason"]);
    expect(missingRequiredResponseIds(questions, { reason: "Approved after review" })).toEqual([]);
  });

  test("mirrors the server rules for every question type", () => {
    const questions: ApprovalQuestion[] = [
      { id: "approve", type: "approval", label: "Approve?", required: true },
      { id: "boolean", type: "boolean", label: "Continue?", required: true },
      {
        id: "single",
        type: "single-select",
        label: "Choose one",
        required: true,
        options: [{ value: "one", label: "One" }],
      },
      {
        id: "multi",
        type: "multi-select",
        label: "Choose two",
        required: true,
        minSelections: 2,
        maxSelections: 2,
        options: [
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ],
      },
    ];

    expect(
      missingRequiredResponseIds(questions, {
        approve: { approved: false },
        boolean: false,
        single: "one",
        multi: ["one", "two"],
      }),
    ).toEqual([]);
    expect(
      missingRequiredResponseIds(questions, {
        approve: {},
        boolean: "false",
        single: "unknown",
        multi: ["one"],
      }),
    ).toEqual(["approve", "boolean", "single", "multi"]);
  });
});

describe("config questions", () => {
  const question = (required: boolean): ApprovalQuestion => ({
    id: "cfg",
    type: "config",
    label: "Token",
    required,
    config: { key: "BITBUCKET_TOKEN", scope: "global", isSecret: true },
  });

  test("a required config question needs set with a value, or keep", () => {
    const questions = [question(true)];
    expect(missingRequiredResponseIds(questions, {})).toEqual(["cfg"]);
    expect(missingRequiredResponseIds(questions, { cfg: { action: "skip" } })).toEqual(["cfg"]);
    expect(missingRequiredResponseIds(questions, { cfg: { action: "set", value: " " } })).toEqual([
      "cfg",
    ]);
    expect(missingRequiredResponseIds(questions, { cfg: { action: "set", value: "v" } })).toEqual(
      [],
    );
    expect(missingRequiredResponseIds(questions, { cfg: { action: "keep" } })).toEqual([]);
  });

  test("an optional config question never blocks", () => {
    expect(missingRequiredResponseIds([question(false)], { cfg: { action: "skip" } })).toEqual([]);
  });
});
