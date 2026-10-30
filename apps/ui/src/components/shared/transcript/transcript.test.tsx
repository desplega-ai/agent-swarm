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
  "@/components/shared/task-status-icon",
  "@/components/ui/button",
  "@/components/ui/collapsible",
  "@/components/ui/trace",
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
  classifyTool: (name: string) => ({ kind: "other", name }),
}));

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { Transcript } = await import("./transcript");
const { buildTranscriptRows } = await import("./transcript-rows");

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
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
