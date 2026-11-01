import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { AgentTask, SteeringMessage } from "@/api/types";

// A DOM for the client render; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// The root `bun test` does not resolve the UI's `@/` alias. Each maps to the
// real module, except the markdown renderer (Monaco) and the raw log viewer.
const SRC = new URL("../../../", import.meta.url).pathname;
for (const alias of [
  "@/components/session-panel/model",
  "@/components/steering/steering-message-chips",
  "@/components/steering/steering-receipt",
  "@/components/shared/copy-value-button",
  "@/components/shared/message-copy-button",
  "@/components/shared/relative-time",
  "@/lib/relative-time",
  "@/components/shared/prompt-context",
  "@/components/shared/task-status-icon",
  "@/components/ui/button",
  "@/components/ui/badge",
  "@/components/ui/popover",
  "@/components/ui/collapsible",
  "@/components/ui/tooltip",
  "@/components/ui/trace",
  "@/hooks/use-copy-to-clipboard",
  "@/hooks/use-media-query",
  "@/hooks/use-reveal-text",
  "@/lib/auto-review",
  "@/lib/json-value",
  "@/lib/prompt-display",
  "@/lib/reveal-text",
  "@/lib/status-labels",
  "@/lib/task-activity",
  "@/lib/task-title",
  "@/lib/utils",
]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}
mock.module("@/api/hooks/use-users", () => ({
  useUsers: () => ({ data: [{ id: "u1", name: "Taras" }] }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("@/components/shared/user-avatar", () => ({
  UserAvatar: ({ id, name }: { id: string; name: string }) => (
    <span role="img" aria-label={name} data-user-id={id} />
  ),
}));
mock.module("@/components/shared/agent-avatar", () => ({
  AgentAvatar: ({ agentId }: { agentId: string }) => (
    <span data-testid="agent-avatar" data-agent-id={agentId} />
  ),
}));
mock.module("@/components/shared/markdown-view", () => ({
  MarkdownView: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));
mock.module("@/components/shared/session-log-viewer", () => ({
  classifyTool: (name: string) =>
    name === "Bash"
      ? { kind: "bash", name: "bash", server: "", title: "bash", detail: "git fetch" }
      : { kind: "other", name, server: "", title: name, detail: "" },
}));

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { Transcript, TranscriptUserMessage } = await import("./transcript");
const { buildTranscriptRows } = await import("./transcript-rows");
const { TaskTranscript } = await import("./task-transcript");

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return {
    container,
    rerender: async (next: React.ReactNode) => {
      await act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function steering(id: string, body: string, status: SteeringMessage["status"]): SteeringMessage {
  return {
    id,
    taskId: "t1",
    body,
    mode: "queue",
    status,
    createdByKind: "user",
    createdByUserId: "u1",
    createdAt: "2026-10-30T10:00:00Z",
    deliveredAt: status === "pending" ? undefined : "2026-10-30T10:00:05Z",
  } as SteeringMessage;
}

describe("Transcript steering", () => {
  test("steering keeps the sender and a receipt for every lifecycle state", async () => {
    const rows = buildTranscriptRows({
      messages: [],
      steering: [
        steering("s1", "Use the staging DB", "delivered"),
        steering("s2", "Then open the PR", "pending"),
        steering("s3", "Use Carbon tokens", "handled"),
        steering("s4", "Try another task", "promoted"),
        steering("s5", "Never mind", "cancelled"),
      ],
    });
    const { container, unmount } = await mount(<Transcript rows={rows} running />);
    const messages = [
      ...container.querySelectorAll('section[aria-label="Steering message"]'),
    ] as HTMLElement[];
    expect(messages).toHaveLength(5);
    for (const message of messages) {
      expect(message.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Taras");
      expect(message.className).toContain("flex-row-reverse");
      const controls = [...message.querySelectorAll("button, time")].map((el) =>
        el.tagName === "TIME" ? "time" : el.getAttribute("aria-label"),
      );
      expect(controls).toEqual([
        "Show raw",
        "Copy message",
        message.querySelector('[data-slot="steering-receipt"]')?.getAttribute("aria-label"),
        "time",
      ]);
    }
    expect(
      [...container.querySelectorAll('[data-slot="steering-receipt"]')].map((el) =>
        el.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Delivered: message status",
      "Processed: message status",
      "Follow-up task: message status",
      "Cancelled: message status",
      "Queued: message status",
    ]);
    expect(messages[0].textContent).toContain("Use the staging DB");
    await unmount();
  });

  test("the receipt shows confirmed processing time and the acknowledgement note", async () => {
    const message = {
      ...steering("s1", "Use Carbon tokens", "handled"),
      handledAt: "2026-10-30T10:00:12Z",
      handledNote: "Applied the Carbon theme tokens.",
    };
    const rows = buildTranscriptRows({ messages: [], steering: [message] });
    const { container, unmount } = await mount(<Transcript rows={rows} running={false} />);
    const button = container.querySelector<HTMLButtonElement>('[data-slot="steering-receipt"]')!;
    await act(async () => button.click());
    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).toContain("The agent confirmed handling this message.");
    expect(popover?.textContent).toContain("Applied the Carbon theme tokens.");
    expect(popover?.textContent).toContain("BCN");
    expect([...popover!.querySelectorAll("time")].map((el) => el.dateTime)).toEqual([
      message.createdAt,
      message.deliveredAt!,
      message.handledAt,
    ]);
    await unmount();
  });

  test("another sender's message stays on the left with their identity", async () => {
    const rows = buildTranscriptRows({
      messages: [],
      steering: [
        {
          ...steering("s1", "Check this too", "pending"),
          createdByUserId: "u2",
          senderLabel: "Lena",
        },
      ],
    });
    const { container, unmount } = await mount(<Transcript rows={rows} running />);
    const message = container.querySelector('section[aria-label="Steering message"]')!;
    expect(message.className).not.toContain("flex-row-reverse");
    expect(message.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Lena");
    expect(message.textContent).toContain("Lena");
    expect(
      [...message.querySelectorAll("button, time")].map((el) =>
        el.tagName === "TIME" ? "time" : el.getAttribute("aria-label"),
      ),
    ).toEqual(["time", "Queued: message status", "Show raw", "Copy message"]);
    await unmount();
  });

  test("a delivery receipt changes only after the agent acknowledges processing", async () => {
    const message = steering("s1", "Use Carbon tokens", "delivered");
    const rows = (next: SteeringMessage) => buildTranscriptRows({ messages: [], steering: [next] });
    const { container, rerender, unmount } = await mount(
      <Transcript rows={rows(message)} running />,
    );
    const receipt = () => container.querySelector('[data-slot="steering-receipt"]');
    expect(receipt()?.getAttribute("aria-label")).toBe("Delivered: message status");
    await rerender(
      <Transcript
        rows={rows({ ...message, status: "handled", handledAt: "2026-10-30T10:00:12Z" })}
        running={false}
      />,
    );
    expect(receipt()?.getAttribute("aria-label")).toBe("Processed: message status");
    expect(container.querySelectorAll('section[aria-label="Steering message"]')).toHaveLength(1);
    await unmount();
  });
});

describe("Transcript outcome", () => {
  const rows = buildTranscriptRows({
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "Done, see the PR." }],
        iteration: 1,
        timestamp: "2026-10-30T10:00:01Z",
      },
    ],
  });
  const fold = { label: "Worked for 1m", open: false, onOpenChange: () => {} };

  test("comes last; folded, it hides the last message that says the same", async () => {
    const { container, unmount } = await mount(
      <Transcript
        rows={rows}
        running={false}
        fold={fold}
        outcome={<p data-testid="outcome">Done, see the PR.</p>}
        outcomeText="Done, see the PR."
      />,
    );
    const transcript = container.querySelector('[data-slot="transcript"]') as HTMLElement;
    expect(transcript.lastElementChild?.getAttribute("data-testid")).toBe("outcome");
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();
    await unmount();
  });

  test("an outcome that says something else keeps the agent's last message", async () => {
    const { container, unmount } = await mount(
      <Transcript
        rows={rows}
        running={false}
        fold={fold}
        outcome={<p data-testid="outcome">Completed by runner wrapper (no explicit output)</p>}
        outcomeText="Completed by runner wrapper (no explicit output)"
      />,
    );
    expect(container.querySelector('[data-testid="markdown"]')?.textContent).toBe(
      "Done, see the PR.",
    );
    const transcript = container.querySelector('[data-slot="transcript"]') as HTMLElement;
    expect(transcript.lastElementChild?.getAttribute("data-testid")).toBe("outcome");
    await unmount();
  });
});

describe("Transcript details and copy", () => {
  const command = "git fetch -q origin && gh pr view 2589 --json state,mergedAt | grep -i 258";
  const rows = buildTranscriptRows({
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "Checking the PR." }],
        iteration: 1,
        timestamp: "2026-10-30T10:00:01Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }],
        iteration: 1,
        timestamp: "2026-10-30T10:00:02Z",
      },
      {
        id: "m3",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", isError: true }],
        iteration: 1,
        timestamp: "2026-10-30T10:00:05Z",
      },
    ],
  });

  test("a tool line is a button that opens to the full command and the output", async () => {
    const { container, unmount } = await mount(<Transcript rows={rows} running={false} />);
    const trigger = container.querySelector(
      '[data-slot="trace-collapsible-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="transcript-tool-details"]')).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const details = container.querySelector('[data-slot="transcript-tool-details"]') as HTMLElement;
    const blocks = [...details.querySelectorAll("pre")].map((pre) => pre.textContent);
    expect(blocks).toEqual([command, "exit 1"]);
    expect(details.textContent).toContain("Failed");
    expect(details.textContent).toContain("3s");
    expect(details.querySelector('button[aria-label="Copy command"]')).not.toBeNull();
    expect(details.querySelector('button[aria-label="Copy output"]')).not.toBeNull();
    await unmount();
  });

  test("the person's message and the agent's prose each have a Copy", async () => {
    const { container, unmount } = await mount(
      <Transcript
        rows={rows}
        running={false}
        prompt={<TranscriptUserMessage text="Is PR 2589 merged?" />}
      />,
    );
    const prompt = container.querySelector('section[aria-label="Task prompt"]') as HTMLElement;
    expect(prompt.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    const prose = container.querySelector('[data-slot="transcript-assistant"]') as HTMLElement;
    expect(prose.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    await unmount();
  });
});

describe("Transcript live line", () => {
  const call = (n: number) => ({
    id: `c${n}`,
    role: "assistant" as const,
    content: [
      { type: "tool_use" as const, id: `t${n}`, name: "Bash", input: { command: `step ${n}` } },
    ],
    iteration: 1,
    timestamp: `2026-10-30T10:00:0${n}Z`,
  });
  const live = (n: number) => buildTranscriptRows({ messages: [1, 2, 3].slice(0, n).map(call) });
  const lastTrigger = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-slot="trace-collapsible-trigger"]')].at(
      -1,
    ) as HTMLButtonElement;

  test("a new call closes the open live line instead of showing its details", async () => {
    const { container, rerender, unmount } = await mount(<Transcript rows={live(2)} running />);
    await act(async () => lastTrigger(container).click());
    expect(container.querySelector('[data-slot="transcript-tool-details"] pre')?.textContent).toBe(
      "step 2",
    );

    await rerender(<Transcript rows={live(3)} running />);
    expect(lastTrigger(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="transcript-tool-details"]')).toBeNull();
    await unmount();
  });
});

describe("Transcript delegation", () => {
  test("the subtitle shows the agent's avatar before its name", async () => {
    const task = {
      id: "c1",
      task: "Check the env gap",
      status: "completed",
      agentId: "lead-1",
      createdAt: "2026-10-30T10:00:00Z",
      acceptedAt: "2026-10-30T10:00:00Z",
      finishedAt: "2026-10-30T10:01:23Z",
    } as AgentTask;
    const rows = buildTranscriptRows({ messages: [], children: [{ task, agentName: "Lead" }] });
    const { container, unmount } = await mount(
      <MemoryRouter>
        <Transcript rows={rows} running={false} />
      </MemoryRouter>,
    );
    const card = container.querySelector('[data-slot="transcript-delegation"]') as HTMLElement;
    const avatar = card.querySelector('[data-testid="agent-avatar"]') as HTMLElement;
    expect(avatar.dataset.agentId).toBe("lead-1");
    expect(avatar.parentElement?.textContent).toBe("Delegated toLead · Completed · 1m 23s");
    await unmount();
  });
});

describe("Transcript person message", () => {
  test("shows markdown, switches to the raw text, and copies the raw text", async () => {
    const text = "Check `db.ts`:\n- one\n- two";
    const { container, unmount } = await mount(
      <Transcript rows={[]} running={false} prompt={<TranscriptUserMessage text={text} />} />,
    );
    const prompt = container.querySelector('section[aria-label="Task prompt"]') as HTMLElement;
    expect(prompt.querySelector('[data-testid="markdown"]')?.textContent).toBe(text);

    const toggle = prompt.querySelector('button[aria-label="Show raw"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(prompt.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(prompt.textContent).toContain(text);
    expect(toggle.getAttribute("aria-label")).toBe("Show formatted");
    expect(prompt.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    await unmount();
  });
});

describe("Transcript fake streaming", () => {
  const message = (id: string, text: string, timestamp: string) => ({
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    iteration: 1,
    timestamp,
  });
  const history = message("m1", "Looking at the failing test.", "2026-10-30T10:00:01Z");
  const text = "Found the cause: the fixture reused a stale id.";
  const prose = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-slot="transcript-assistant"]')] as HTMLElement[];
  // `act` renders its queued updates when it ends, so each call runs one step.
  const step = () => act(async () => new Promise((r) => setTimeout(r, 40)));

  test("a message that a poll brings in fades in and reveals word by word", async () => {
    const { container, rerender, unmount } = await mount(
      <Transcript rows={buildTranscriptRows({ messages: [history] })} running />,
    );
    const later = "2026-10-30T10:00:09Z";
    await rerender(
      <Transcript
        rows={buildTranscriptRows({ messages: [history, message("m2", text, later)] })}
        running
      />,
    );
    const [old, fresh] = prose(container);
    expect(old.textContent).toBe(history.content[0].text);
    expect(old.className).not.toContain("animate-in");
    expect(fresh.className).toContain("animate-in");
    const first = fresh.querySelector('[data-testid="markdown"]')?.textContent ?? "";
    expect(first.length).toBeLessThan(text.length);
    expect(text.startsWith(first)).toBe(true);

    await step();
    const mid = fresh.querySelector('[data-testid="markdown"]')?.textContent ?? "";
    expect(mid.length).toBeGreaterThan(first.length);
    expect(text.startsWith(mid)).toBe(true);
    expect(text.charAt(mid.length)).toBe(" ");

    const markdown = () => fresh.querySelector('[data-testid="markdown"]')?.textContent;
    for (let i = 0; i < 20 && markdown() !== text; i++) await step();
    expect(markdown()).toBe(text);
    await unmount();
  });

  test("the browser clock does not matter: only data newer than the first rows arrives", async () => {
    // The server is 20 s ahead of the browser: the first rows look like the future.
    const ahead = (s: number) => new Date(Date.now() + 20_000 + s * 1000).toISOString();
    const first = message("m1", "Looking at the failing test.", ahead(0));
    const { container, rerender, unmount } = await mount(
      <Transcript rows={buildTranscriptRows({ messages: [first] })} running />,
    );
    expect(prose(container)[0].textContent).toBe(first.content[0].text);
    expect(prose(container)[0].className).not.toContain("animate-in");

    // A poll brings a row: newer than the first rows, older than the browser's clock.
    const behind = message("m0", "Earlier note.", "2026-10-30T10:00:00Z");
    await rerender(
      <Transcript
        rows={buildTranscriptRows({ messages: [behind, first, message("m2", text, ahead(4))] })}
        running
      />,
    );
    const [old, kept, fresh] = prose(container);
    expect(old.className).not.toContain("animate-in");
    expect(kept.className).not.toContain("animate-in");
    expect(fresh.className).toContain("animate-in");
    expect(fresh.textContent?.length).toBeLessThan(text.length);
    await unmount();
  });

  test("the end of the run shows the whole text at once", async () => {
    const { container, rerender, unmount } = await mount(
      <Transcript rows={buildTranscriptRows({ messages: [history] })} running />,
    );
    const rows = buildTranscriptRows({
      messages: [history, message("m2", text, "2026-10-30T10:00:09Z")],
    });
    await rerender(<Transcript rows={rows} running />);
    await rerender(<Transcript rows={rows} running={false} />);
    expect(prose(container).at(-1)?.textContent).toBe(text);
    await unmount();
  });
});

describe("Transcript tasks this one started", () => {
  const child = (id: string, extra: Partial<AgentTask>) =>
    ({
      id,
      task: `Task ${id}`,
      status: "completed",
      agentId: "lead-1",
      createdAt: "2026-10-31T00:09:34Z",
      source: "mcp",
      tags: [],
      ...extra,
    }) as AgentTask;
  const parent = {
    task: "Say hi",
    status: "completed" as const,
    createdAt: "2026-10-30T13:50:00Z",
    acceptedAt: "2026-10-30T13:50:00Z",
    finishedAt: "2026-10-30T13:51:00Z",
  };

  async function render(children: AgentTask[]) {
    const rows = buildTranscriptRows({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
          iteration: 1,
          timestamp: "2026-10-30T13:50:30Z",
        },
      ],
      children: children.map((task) => ({ task, agentName: "Lead" })),
    });
    return mount(
      <MemoryRouter>
        <TaskTranscript
          task={parent}
          rows={rows}
          scroller={null}
          outcome={<p data-testid="outcome">Hi Taras. What do you need?</p>}
        />
      </MemoryRouter>,
    );
  }

  test("a person's follow-up after the run is their message, after the outcome", async () => {
    const { container, unmount } = await render([
      child("f1", { task: "asdf", source: "ui", status: "pending", requestedByUserId: "u1" }),
    ]);
    const transcript = container.querySelector('[data-slot="transcript"]') as HTMLElement;
    const order = [...transcript.children].map(
      (el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label"),
    );
    expect(order.slice(-2)).toEqual(["outcome", "Follow-up message"]);
    const status = container.querySelector('[data-slot="transcript-follow-up-status"]');
    expect(status?.textContent).toBe("Follow-up from Taras toLead · Pending");
    expect(status?.getAttribute("href")).toBe("/tasks/f1");
    await unmount();
  });

  test("a wake-up, a resume and the result sent to the lead are quiet lines", async () => {
    const { container, unmount } = await render([
      child("d1", { taskType: "deferred", source: "schedule" }),
      child("r1", {
        taskType: "resume",
        source: "system",
        tags: ["auto-resume", "reason:graceful_shutdown"],
        createdAt: "2026-10-31T00:10:00Z",
      }),
      child("n1", { taskType: "follow-up", source: "system", createdAt: "2026-10-31T00:11:00Z" }),
    ]);
    const lines = [...container.querySelectorAll('[data-slot="transcript-child-line"]')].map(
      (el) => el.textContent,
    );
    expect(lines[0]).toStartWith("Deferred until ");
    expect(lines[0]).toEndWith("·Lead · Completed");
    expect(lines.slice(1)).toEqual([
      "Resumed after a shutdown ·Lead · Completed",
      "Result sent toLead · Completed",
    ]);
    await unmount();
  });
});
