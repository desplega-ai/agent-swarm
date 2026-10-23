import { describe, expect, test } from "bun:test";
import { parsePromptDisplay, promptTitle } from "./prompt-display";

// The shape of a Slack-sourced session root, as `src/slack/handlers.ts` writes it.
const SLACK_PROMPT = `<thread_context>
<@U02E8EYCJFN> (unknown user): otra que no sé si está bien
<@U08NY4B5R2M|Eze>: creo que falta el deploy
<@U0A3YMSRKJB> (that's you): I can check it
</thread_context>

<@U08NY4B5R2M|Eze>: <@U0A3YMSRKJB> (that's you) can you check why <#C1|ops> did not get the alert?`;

const SIBLING_PROMPT = `<sibling_tasks_in_progress>
The following tasks are already running in the same context (contextKey: slack:C1:1.2). The user has submitted new input while they were in flight — coordinate with them, do not duplicate:

- [in_progress] task:abc — agent:Picateclas — started 2m ago, last active 10s ago
  "fix the build"
</sibling_tasks_in_progress>

also bump the version`;

describe("parsePromptDisplay", () => {
  test("a Slack session root: the ask, its speaker, and the thread above it", () => {
    const display = parsePromptDisplay(SLACK_PROMPT);
    expect(display.title).toBe("can you check why #ops did not get the alert?");
    expect(display.speaker).toBe("Eze");
    expect(display.ask).toBe("can you check why #ops did not get the alert?");
    expect(display.meta).toEqual([]);
    expect(display.sections).toEqual([
      {
        tag: "thread_context",
        label: "Thread context",
        messages: [
          { speaker: undefined, text: "otra que no sé si está bien" },
          { speaker: "Eze", text: "creo que falta el deploy" },
          { speaker: "Agent", text: "I can check it" },
        ],
      },
    ]);
  });

  test("a sibling_tasks block becomes a section, and the title is the new input", () => {
    const display = parsePromptDisplay(SIBLING_PROMPT);
    expect(display.title).toBe("also bump the version");
    expect(display.ask).toBe("also bump the version");
    expect(display.sections).toHaveLength(1);
    expect(display.sections[0]?.tag).toBe("sibling_tasks_in_progress");
    expect(display.sections[0]?.label).toBe("Tasks already running in this thread");
    expect(display.sections[0]?.text).toContain('"fix the build"');
  });

  test("thread context comes first, then other blocks in prompt order", () => {
    const display = parsePromptDisplay(
      `${SIBLING_PROMPT.replace("also bump the version", "")}${SLACK_PROMPT}`,
    );
    expect(display.sections.map((s) => s.tag)).toEqual([
      "thread_context",
      "sibling_tasks_in_progress",
    ]);
    expect(display.title).toBe("can you check why #ops did not get the alert?");
  });

  test("an unknown tag block is a labelled section, never dropped", () => {
    const display = parsePromptDisplay(
      "Review this\n\n<deploy_log>\nstep 1 ok\nstep 2 failed for <@U1|Ana>\n</deploy_log>",
    );
    expect(display.ask).toBe("Review this");
    expect(display.sections).toEqual([
      { tag: "deploy_log", label: "Deploy log", text: "step 1 ok\nstep 2 failed for @Ana" },
    ]);
  });

  test("page feedback is open by default", () => {
    const display = parsePromptDisplay(
      'Feedback on the page "Q3"\n\n<page_feedback>\n- h1: rename it\n</page_feedback>\n\nAct on the feedback.',
    );
    expect(display.title).toBe('Feedback on the page "Q3"');
    expect(display.sections[0]).toMatchObject({ label: "Page feedback", defaultOpen: true });
  });

  test("plain text comes back unchanged", () => {
    const plain = "Summarize the week\n\nUse <div>tags</div> and `a < b > c` as-is.";
    expect(parsePromptDisplay(plain)).toEqual({
      title: "Summarize the week",
      speaker: undefined,
      ask: plain,
      sections: [],
      meta: [],
    });
  });

  test("an inline HTML block is not a wrapper", () => {
    const html = "Fix the markup\n<div>\nhello\n</div>";
    expect(parsePromptDisplay(html).sections).toEqual([]);
    expect(parsePromptDisplay(html).ask).toBe(html);
  });
});

describe("prompt markers", () => {
  test("a Slack thread follow-up prefix moves to meta", () => {
    const display = parsePromptDisplay(
      "[Thread follow-up — 3 message(s) buffered]\n\n<@U1|Ana>: and the staging one too",
    );
    expect(display.meta).toEqual([{ label: "Thread follow-up", value: "3 buffered message(s)" }]);
    expect(display.title).toBe("and the staging one too");
  });

  test("a follow-up after a sibling block still moves to meta, and the asker is found", () => {
    const display = parsePromptDisplay(
      SIBLING_PROMPT.replace(
        "also bump the version",
        "[Thread follow-up — 2 message(s) buffered]\n\n<@U1|Eze>: and check staging too",
      ),
    );
    expect(display.meta).toEqual([{ label: "Thread follow-up", value: "2 buffered message(s)" }]);
    expect(display.speaker).toBe("Eze");
    expect(display.title).toBe("and check staging too");
    expect(display.sections.map((s) => s.tag)).toEqual(["sibling_tasks_in_progress"]);
  });

  test("a Chat SDK thread follow-up prefix moves to meta", () => {
    const display = parsePromptDisplay("[Thread follow-up: 2 message(s) buffered]\n\nship it");
    expect(display.meta).toEqual([{ label: "Thread follow-up", value: "2 buffered message(s)" }]);
    expect(display.ask).toBe("ship it");
  });

  test("a steering envelope and its reminder move to meta", () => {
    const display = parsePromptDisplay(
      '[steering 1234-abcd] From Lead (agent): also check the footers\n\n(Once you have acted on this, call `accept-steer` with steeringMessageId "1234-abcd".)',
    );
    expect(display.meta).toEqual([{ label: "Steering", value: "Lead (agent) (1234-abcd)" }]);
    expect(display.ask).toBe("also check the footers");
  });

  test("a Requested by line moves to meta", () => {
    const display = parsePromptDisplay(
      "Ship the fix\n\nRequested by: Taras (t@example.com, user 4dac)",
    );
    expect(display.meta).toEqual([
      { label: "Requested by", value: "Taras (t@example.com, user 4dac)" },
    ]);
    expect(display.ask).toBe("Ship the fix");
  });

  test("the store-progress reminder moves to meta, after Requested by", () => {
    const display = parsePromptDisplay(
      'Ship the fix\n\nRequested by: Taras\n\nWhen done, use `store-progress` with status: "completed" and include your output.',
    );
    expect(display.meta).toEqual([
      { label: "Requested by", value: "Taras" },
      { label: "Output", value: "store-progress when done" },
    ]);
    expect(display.title).toBe("Ship the fix");
  });

  test("a Requested by line mid-prompt stays text", () => {
    const text = "Requested by: Taras\nfix the build";
    expect(parsePromptDisplay(text).meta).toEqual([]);
  });
});

describe("list previews", () => {
  // `/api/tasks` and `/api/sessions` rows carry the first 300 characters plus `…`.
  test("a preview cut inside the thread block reads its first message", () => {
    const preview = `${SLACK_PROMPT.slice(0, 120)}…`;
    const display = parsePromptDisplay(preview);
    expect(display.title).toBe("@someone: otra que no sé si está bien");
    expect(display.sections[0]?.tag).toBe("thread_context");
    expect(display.ask).toBe("");
  });

  test("a preview cut inside a Slack token drops the cut token", () => {
    expect(promptTitle(`${SLACK_PROMPT.slice(0, SLACK_PROMPT.indexOf("|ops> did"))}…`)).toBe(
      "can you check why …",
    );
  });
});

describe("promptTitle", () => {
  test("a prompt that is only a thread block reads its first message", () => {
    expect(promptTitle("<thread_context>\nPlease review PR 12\n</thread_context>")).toBe(
      "Please review PR 12",
    );
  });
});
