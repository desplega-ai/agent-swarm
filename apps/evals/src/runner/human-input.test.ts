import { describe, expect, test } from "bun:test";
import type { ApprovalQuestionJson, ApprovalRequestJson } from "../swarm/client.ts";
import {
  CANNED_HUMAN,
  cannedAnswer,
  cannedResponses,
  type HumanInputClient,
  HumanResponder,
  settleWithHumanInput,
} from "./human-input.ts";

const REPLY = "EU customers only, as JSON, without email.";

function q(type: ApprovalQuestionJson["type"], extra: Partial<ApprovalQuestionJson> = {}) {
  return { id: `q-${type}`, type, label: type, ...extra } as ApprovalQuestionJson;
}

function request(id: string, questions: ApprovalQuestionJson[]): ApprovalRequestJson {
  return {
    id,
    title: `Request ${id}`,
    questions,
    sourceTaskId: "task-0",
    status: "pending",
    responses: null,
    resolvedAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
  };
}

/** An in-memory approval store: respond resolves the request. */
function fakeClient(initial: ApprovalRequestJson[]) {
  const store = [...initial];
  const responded: string[] = [];
  const client: HumanInputClient = {
    listApprovalRequests: async (status) =>
      store.filter((r) => status === undefined || r.status === status),
    respondApprovalRequest: async (id, responses, by) => {
      const r = store.find((x) => x.id === id);
      if (!r || r.status !== "pending") throw new Error(`${id} -> 409`);
      r.status = "approved";
      r.responses = responses;
      responded.push(`${id}:${by}`);
    },
  };
  return { client, store, responded };
}

describe("cannedAnswer", () => {
  const options = [
    { value: "eu", label: "EU" },
    { value: "us", label: "US" },
    { value: "json", label: "JSON" },
  ];
  test.each([
    ["text", q("text"), REPLY],
    ["approval", q("approval"), { approved: true, comment: REPLY }],
    ["boolean", q("boolean"), true],
    ["single-select naming an option", q("single-select", { options }), "eu"],
    [
      "single-select naming none",
      q("single-select", { options: [{ value: "csv", label: "CSV" }] }),
      "csv",
    ],
    ["multi-select naming two", q("multi-select", { options }), ["eu", "json"]],
    ["multi-select capped", q("multi-select", { options, maxSelections: 1 }), ["eu"]],
  ])("%s", (_label, question, expected) => {
    expect(cannedAnswer(question, REPLY)).toEqual(expected);
  });

  test("cannedResponses keys every question by id and marks generic structured answers", () => {
    expect(cannedResponses(request("r", [q("text"), q("boolean")]), { reply: REPLY })).toEqual({
      responses: { "q-text": REPLY, "q-boolean": true },
      fallbacks: ["q-boolean"],
    });
  });

  test("the scenario's own answer wins when the respond route would accept it", () => {
    const options = [
      { value: "include", label: "Include emails" },
      { value: "exclude", label: "Exclude emails" },
    ];
    const res = cannedResponses(
      request("r", [q("single-select", { options }), q("boolean"), q("multi-select", { options })]),
      {
        reply: "Do not include email addresses.",
        answer: (question) =>
          question.type === "single-select"
            ? "exclude"
            : question.type === "boolean"
              ? false
              : ["not-an-option"],
      },
    );
    expect(res.responses).toEqual({
      "q-single-select": "exclude",
      "q-boolean": false,
      // Invalid own answer (not an option) falls back to the generic mapping.
      "q-multi-select": ["include"],
    });
    expect(res.fallbacks).toEqual(["q-multi-select"]);
  });
});

describe("HumanResponder", () => {
  test("answers each pending request once, signed as the canned human", async () => {
    const { client, responded } = fakeClient([request("r1", [q("text")])]);
    const responder = new HumanResponder(client, { reply: REPLY });
    const counts = await Promise.all([responder.answerPending(), responder.answerPending()]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(responded).toEqual([`r1:${CANNED_HUMAN}`]);
    expect(responder.answered.map((a) => [a.id, a.responses, a.error])).toEqual([
      ["r1", { "q-text": REPLY }, null],
    ]);
  });

  test("a list failure answers nothing and does not throw", async () => {
    const responder = new HumanResponder(
      {
        listApprovalRequests: async () => {
          throw new Error("down");
        },
        respondApprovalRequest: async () => {},
      },
      { reply: REPLY },
    );
    expect(await responder.answerPending()).toBe(0);
  });

  test("the background loop answers a request that appears later, and stops", async () => {
    const { client, store } = fakeClient([]);
    const responder = new HumanResponder(client, { reply: REPLY });
    responder.start(5);
    store.push(request("late", [q("text")]));
    await Bun.sleep(40);
    await responder.stop();
    expect(responder.answered.map((a) => a.id)).toEqual(["late"]);
  });
});

describe("settleWithHumanInput", () => {
  test("an ask after the upfront task ended is answered, and settling waits for the follow-up", async () => {
    const { client, store } = fakeClient([request("r1", [q("text")])]);
    const responder = new HumanResponder(client, { reply: REPLY });
    let waits = 0;
    const res = await settleWithHumanInput({
      responder,
      deadline: Date.now() + 10_000,
      waitForQuiescence: async () => {
        waits++;
        return { open: [] };
      },
    });
    expect(res.open).toEqual([]);
    // wait -> answer r1 -> wait again (the follow-up) -> nothing new -> done.
    expect(waits).toBe(2);
    expect(store[0]?.status).toBe("approved");
  });

  test("with nothing pending it returns after one quiescence wait", async () => {
    const { client } = fakeClient([]);
    let waits = 0;
    await settleWithHumanInput({
      responder: new HumanResponder(client, { reply: REPLY }),
      deadline: Date.now() + 10_000,
      waitForQuiescence: async () => {
        waits++;
        return { open: [] };
      },
    });
    expect(waits).toBe(1);
  });

  test("open tasks at the deadline end the loop as-is", async () => {
    const { client } = fakeClient([request("r1", [q("text")])]);
    const res = await settleWithHumanInput({
      responder: new HumanResponder(client, { reply: REPLY }),
      deadline: Date.now() + 10_000,
      waitForQuiescence: async () => ({ open: ["t1"] }),
    });
    expect(res.open).toEqual(["t1"]);
  });
});
