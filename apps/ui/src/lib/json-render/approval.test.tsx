import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { ApprovalRequest } from "../../api/types";

// The data hooks, the question flow and the status chip are stubbed: these
// tests cover what Approval does with a request (states, respond errors, the
// resolved chain), not the dashboard pieces it reuses. Every other `@/`
// specifier maps to its real file (bun does not resolve vite's alias).
const STUBBED = new Set([
  "@/api/hooks/use-approval-requests",
  "@/components/shared/question-flow",
  "@/components/shared/status-badge",
]);
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  if (STUBBED.has(specifier)) continue;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider, ActionProvider } = await import("@json-render/react");
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const { GrantsContext } = await import("../use-can");
const { approvalPollInterval } = await import("../approval-format");

/** What the server holds; the stub query reads it on every fetch. */
let serverRequest: ApprovalRequest | null = null;
let fetchCount = 0;
let respondImpl: (responses: Record<string, unknown>) => Promise<unknown> = async () => ({});

mock.module("@/api/hooks/use-approval-requests", () => ({
  useLiveApprovalRequest: (id: string) =>
    useQuery({
      queryKey: ["approval-request", id],
      queryFn: async () => {
        fetchCount += 1;
        if (!serverRequest) throw new Error("Failed to fetch approval request: 404");
        return { approvalRequest: structuredClone(serverRequest) };
      },
      select: (data: { approvalRequest: ApprovalRequest }) => data.approvalRequest,
      retry: false,
    }),
  useRespondToApprovalRequest: () => ({
    mutateAsync: ({ responses }: { responses: Record<string, unknown> }) => respondImpl(responses),
  }),
}));

mock.module("@/components/shared/question-flow", () => ({
  // One button that submits a fixed answer; a rejection shows its message.
  QuestionFlow: ({ onSubmit }: { onSubmit: (v: Record<string, unknown>) => Promise<void> }) => (
    <button
      type="button"
      data-testid="submit"
      onClick={() => {
        onSubmit({ go: { approved: true } }).catch((error: Error) => {
          document.body.dataset.flowError = error.message;
        });
      }}
    >
      Submit
    </button>
  ),
}));

mock.module("@/components/shared/status-badge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}));

const { ApprovalComponent } = await import("./approval");

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    title: "Deploy to production?",
    questions: [{ id: "go", type: "approval", label: "Ship it?" }],
    approvers: { policy: "any" },
    status: "pending",
    responses: null,
    approvals: [],
    approvalProgress: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    workflowRunId: null,
    workflowRunStepId: null,
    sourceTaskId: null,
    timeoutSeconds: null,
    expiresAt: null,
    notificationChannels: null,
    createdAt: "2026-11-06T10:00:00Z",
    updatedAt: "2026-11-06T10:00:00Z",
    ...overrides,
  } as ApprovalRequest;
}

const resolvedRequest = makeRequest({
  status: "approved",
  responses: { go: { approved: true } },
  resolvedBy: "operator",
  resolvedAt: "2026-11-06T10:01:00Z",
});

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const roots: { unmount(): void }[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
  delete document.body.dataset.flowError;
  serverRequest = null;
  fetchCount = 0;
  respondImpl = async () => ({});
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Props = Parameters<typeof ApprovalComponent>[0]["props"];

const RESOLVED_CHAIN = [
  {
    action: "app.action",
    params: {
      name: "applyDecision",
      input: {
        status: { $chain: "status" },
        decision: { $chain: "responses/go" },
        by: { $chain: "resolvedBy" },
      },
    },
  },
];

async function mount(props: Props, opts: { canRespond?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const grants =
    opts.canRespond === false
      ? {
          operatorTab: false,
          pending: false,
          grants: { grantsAll: false, verbs: [], roles: ["viewer"] },
        }
      : { operatorTab: true, pending: false, grants: undefined };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const tree = (next: Props): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <GrantsContext.Provider value={grants}>
        <StateProvider initialState={{}}>
          <ActionProvider
            handlers={{
              "app.action": async (params: Record<string, unknown>) => {
                calls.push(params);
              },
            }}
          >
            <ApprovalComponent props={next} />
          </ActionProvider>
        </StateProvider>
      </GrantsContext.Provider>
    </QueryClientProvider>
  );
  await act(async () => root.render(tree(props)));
  await settle();
  return {
    host,
    calls,
    /** The next poll: re-read the server's request. */
    poll: async () => {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["approval-request"] });
      });
      await settle();
    },
    rerender: async (next: Props) => {
      await act(async () => root.render(tree(next)));
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const byTestId = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(element: HTMLElement | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.click();
  });
  await settle();
}

describe("Approval", () => {
  test("an empty requestId renders nothing and fetches nothing", async () => {
    const { host } = await mount({ requestId: "" });
    expect(host.innerHTML).toBe("");
    expect(fetchCount).toBe(0);
  });

  test("pending, then answered by the viewer: shows the answers and runs onResolved once", async () => {
    serverRequest = makeRequest();
    let sent: Record<string, unknown> | undefined;
    respondImpl = async (responses) => {
      sent = responses;
      serverRequest = resolvedRequest;
      return { approvalRequest: resolvedRequest };
    };
    const { host, calls, poll } = await mount({ requestId: "req-1", onResolved: RESOLVED_CHAIN });
    expect(byTestId(host, "status")?.textContent).toBe("pending");
    expect(calls).toEqual([]);

    await click(byTestId(host, "submit"));
    expect(sent).toEqual({ go: { approved: true } });
    expect(byTestId(host, "status")?.textContent).toBe("approved");
    expect(byTestId(host, "json-render-approval-answers")).not.toBeNull();
    expect(calls).toEqual([
      {
        name: "applyDecision",
        input: { status: "approved", decision: { approved: true }, by: "operator" },
      },
    ]);

    // Later polls of the same resolved request never re-run the chain.
    await poll();
    await poll();
    expect(calls).toHaveLength(1);
  });

  test("resolved elsewhere: the next poll shows it and runs onResolved once", async () => {
    serverRequest = makeRequest();
    const { host, calls, poll } = await mount({ requestId: "req-1", onResolved: RESOLVED_CHAIN });
    expect(calls).toEqual([]);
    serverRequest = resolvedRequest;
    await poll();
    expect(byTestId(host, "status")?.textContent).toBe("approved");
    expect(calls).toHaveLength(1);
    await poll();
    expect(calls).toHaveLength(1);
  });

  test("a request already resolved on load shows its answers and does not run onResolved", async () => {
    serverRequest = resolvedRequest;
    const { host, calls } = await mount({ requestId: "req-1", onResolved: RESOLVED_CHAIN });
    expect(byTestId(host, "json-render-approval-answers")).not.toBeNull();
    expect(byTestId(host, "submit")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("showResolved: false shows only the outcome line", async () => {
    serverRequest = resolvedRequest;
    const { host } = await mount({ requestId: "req-1", showResolved: false });
    expect(byTestId(host, "json-render-approval-answers")).toBeNull();
    expect(host.textContent).toContain("Approved");
  });

  test("compact drops the card chrome", async () => {
    serverRequest = makeRequest();
    const { host } = await mount({ requestId: "req-1", compact: true });
    expect(byTestId(host, "status")).toBeNull();
    expect(byTestId(host, "submit")).not.toBeNull();
  });

  test("a viewer whose role cannot answer gets a read-only card with Open in dashboard", async () => {
    serverRequest = makeRequest();
    let responded = false;
    respondImpl = async () => {
      responded = true;
      return {};
    };
    const { host } = await mount({ requestId: "req-1" }, { canRespond: false });
    expect(byTestId(host, "submit")).toBeNull();
    const readOnly = byTestId(host, "json-render-approval-readonly");
    expect(readOnly?.textContent).toContain("Ship it?");
    const link = readOnly?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/approval-requests/req-1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(responded).toBe(false);
  });

  test("a 403 on submit turns the card read-only with the server's reason", async () => {
    serverRequest = makeRequest();
    respondImpl = async () => {
      throw new HttpError("You are not an approver of this request", 403);
    };
    const { host } = await mount({ requestId: "req-1" });
    await click(byTestId(host, "submit"));
    const readOnly = byTestId(host, "json-render-approval-readonly");
    expect(readOnly?.textContent).toContain("You are not an approver of this request");
    expect(document.body.dataset.flowError).toBeUndefined();
  });

  test("a 409 on submit refetches and shows the resolved state instead of an error", async () => {
    serverRequest = makeRequest();
    respondImpl = async () => {
      // Someone else answered between our last poll and the submit.
      serverRequest = resolvedRequest;
      throw new HttpError("Approval request is already approved", 409);
    };
    const { host, calls } = await mount({ requestId: "req-1", onResolved: RESOLVED_CHAIN });
    const before = fetchCount;
    await click(byTestId(host, "submit"));
    expect(fetchCount).toBeGreaterThan(before);
    expect(byTestId(host, "status")?.textContent).toBe("approved");
    expect(document.body.dataset.flowError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("a 200 that leaves the request pending (quorum) says the answer is recorded", async () => {
    serverRequest = makeRequest({ approvers: { policy: "all" } });
    respondImpl = async () => ({ approvalRequest: serverRequest });
    const { host, calls } = await mount({ requestId: "req-1", onResolved: RESOLVED_CHAIN });
    await click(byTestId(host, "submit"));
    expect(host.textContent).toContain("Your answer is recorded");
    expect(byTestId(host, "submit")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("other respond errors stay in the form", async () => {
    serverRequest = makeRequest();
    respondImpl = async () => {
      throw new HttpError("Server exploded", 500);
    };
    const { host } = await mount({ requestId: "req-1" });
    await click(byTestId(host, "submit"));
    expect(document.body.dataset.flowError).toBe("Server exploded");
    expect(byTestId(host, "submit")).not.toBeNull();
  });

  test("an unreadable request shows an error callout", async () => {
    serverRequest = null;
    const { host } = await mount({ requestId: "missing" });
    expect(host.textContent).toContain("Approval request unavailable");
  });

  test("a new requestId starts fresh", async () => {
    serverRequest = resolvedRequest;
    const { host, rerender } = await mount({ requestId: "req-1" });
    expect(byTestId(host, "submit")).toBeNull();
    serverRequest = makeRequest({ id: "req-2" });
    await rerender({ requestId: "req-2" });
    expect(byTestId(host, "submit")).not.toBeNull();
  });
});

describe("approvalPollInterval", () => {
  test("polls every 5 s while pending or not yet loaded, and stops on a terminal status", () => {
    expect(approvalPollInterval(undefined)).toBe(5000);
    expect(approvalPollInterval("pending")).toBe(5000);
    for (const status of ["approved", "rejected", "timeout", "cancelled"] as const) {
      expect(approvalPollInterval(status)).toBe(false);
    }
  });
});
