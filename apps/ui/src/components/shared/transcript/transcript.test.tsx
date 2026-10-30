import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { SteeringMessage } from "@/api/types";

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
  "@/components/shared/copy-value-button",
  "@/components/shared/message-copy-button",
  "@/components/shared/task-status-icon",
  "@/components/ui/button",
  "@/components/ui/collapsible",
  "@/components/ui/tooltip",
  "@/components/ui/trace",
  "@/hooks/use-copy-to-clipboard",
  "@/lib/json-value",
  "@/lib/status-labels",
  "@/lib/task-title",
  "@/lib/utils",
]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}
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
    createdAt: "2026-10-30T10:00:00Z",
    deliveredAt: status === "pending" ? undefined : "2026-10-30T10:00:05Z",
  } as SteeringMessage;
}

describe("Transcript steering", () => {
  test("steering messages are the person's message; only a pending one says Queued", async () => {
    const rows = buildTranscriptRows({
      messages: [],
      steering: [
        steering("s1", "Use the staging DB", "delivered"),
        steering("s2", "Then open the PR", "pending"),
      ],
    });
    const { container, unmount } = await mount(<Transcript rows={rows} running />);
    const messages = [
      ...container.querySelectorAll('section[aria-label="Steering message"]'),
    ] as HTMLElement[];
    expect(messages.map((m) => m.dataset.slot)).toEqual(["transcript-user", "transcript-user"]);
    expect(messages[0].textContent).toBe("Use the staging DB");
    expect(messages[0].querySelector('[data-slot="transcript-queued"]')).toBeNull();
    expect(messages[1].textContent).toContain("Then open the PR");
    expect(messages[1].querySelector('[data-slot="transcript-queued"]')?.textContent).toBe(
      "Queued",
    );
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
