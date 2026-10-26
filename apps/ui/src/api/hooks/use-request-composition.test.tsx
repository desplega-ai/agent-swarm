import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { CompositionManifest } from "../../lib/request-composition";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function manifest(seq: number): CompositionManifest {
  return {
    id: `m-${seq}`,
    taskId: "task-1",
    agentId: "agent-1",
    sessionId: "s-1",
    seq,
    provider: "pi",
    model: null,
    source: seq === 0 ? "worker" : "harness-hook",
    parts: [],
    staticEstTokens: 0,
    tokenRatio: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
  };
}

const server: CompositionManifest[] = [manifest(0)];
let reads = 0;
mock.module("../client", () => ({
  api: {
    fetchTaskRequestComposition: async () => {
      reads++;
      return [...server];
    },
  },
}));

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { useRequestComposition } = await import("./use-tasks");

test("reads once more when the task ends, so a seq1 posted after the last poll shows", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe({ live }: { live: boolean }) {
    useRequestComposition("task-1", { enabled: true, sessionIds: ["s-1"], live });
    return null;
  }
  const seqs = () =>
    client
      .getQueryData<CompositionManifest[]>(["task", "task-1", "request-composition", "s-1"])
      ?.map((m) => m.seq);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (live: boolean) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe live={live} />
        </QueryClientProvider>,
      );
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  try {
    await render(true);
    expect(seqs()).toEqual([0]);

    // The hook posts seq1; the task ends before the next 60 s poll.
    server.push(manifest(1));
    await render(true);
    expect(seqs()).toEqual([0]);
    const before = reads;
    await render(false);
    expect(reads).toBe(before + 1);
    expect(seqs()).toEqual([0, 1]);

    // Done stays done: a rerender reads nothing more.
    await render(false);
    expect(reads).toBe(before + 1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
