import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { FeedbackInput } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: "test" });
const { createRoot } = await import("react-dom/client");

let telemetry = true;
/** Outcomes for the next requests, in order; empty means success. */
let outcomes: Array<"error" | "defer"> = [];
let deferred: Array<() => void> = [];
const posted: FeedbackInput[] = [];
const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({
    data: [
      { key: "telemetry_installation_id", value: "install_0123456789abcdef" },
      { key: "telemetry_installed_at", value: "2026-01-01T00:00:00.000Z" },
    ],
  }),
}));
mock.module("@/api/hooks/use-feedback", () => ({
  useSubmitFeedback: () => ({
    isPending: false,
    mutate: (input: FeedbackInput, opts?: { onSuccess?: () => void; onError?: () => void }) => {
      posted.push(input);
      const outcome = outcomes.shift();
      if (outcome === "error") opts?.onError?.();
      else if (outcome === "defer") deferred.push(() => opts?.onSuccess?.());
      else opts?.onSuccess?.();
    },
  }),
}));
mock.module("@/api/hooks/use-ui-telemetry", () => ({
  isUiTelemetryEnabled: () => telemetry,
  useUiTelemetry: () => (input: { event: string; properties: Record<string, unknown> }) =>
    events.push(input),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({
    data: {
      identity: { is_cloud: false, name: "Acme" },
      telemetry: { enabled: telemetry },
      instance: {
        first_seen_at: "2026-01-01T00:00:00.000Z",
        tasks_completed: 0,
        tasks_failed: 0,
        workflow_runs_completed: 1,
      },
    },
  }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ state: "ready", userId: "admin", user: { role: "admin" } }),
}));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({ config: { apiUrl: "https://card.example" } }),
}));
mock.module("@/hooks/use-other-dialog-open", () => ({
  promptShownThisLoad: () => false,
  useOtherDialogOpen: () => false,
}));
mock.module("@/lib/feedback-popup", () => require("../../lib/feedback-popup"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/user-role", () => require("../../lib/user-role"));
mock.module("@/components/ui/label", () => ({ Label: Box }));
mock.module("@/components/ui/input", () => ({ Input: () => <input /> }));
mock.module("@/components/ui/textarea", () => ({
  Textarea: ({ onChange }: { onChange: (e: { target: { value: string } }) => void }) => (
    <textarea onInput={(event) => onChange({ target: { value: event.currentTarget.value } })} />
  ),
}));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    asChild,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
    disabled?: boolean;
    asChild?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <button type={type === "submit" ? "submit" : "button"} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
}));

const { FeedbackDialog } = await import("./feedback-dialog");

let cleanup: (() => Promise<void>) | undefined;
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<FeedbackDialog />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

beforeEach(() => {
  telemetry = true;
  outcomes = [];
  deferred = [];
  posted.length = 0;
  events.length = 0;
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("shows the 0-10 scale with no Send until a score is picked", async () => {
  const container = await mount();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button(container, "0")).toBeDefined();
  expect(button(container, "10")).toBeDefined();
  expect(button(container, "Send")).toBeUndefined();
  expect(posted).toEqual([]);
  expect(events[0]).toEqual({
    event: "popup.shown",
    properties: { popup: "feedback", trigger: "workflow_completed" },
  });
});

test("one tap posts the score on the 0-10 scale, stamped at send time", async () => {
  const container = await mount();
  const openedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => button(container, "8")?.click());
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    nps: 8,
    scale: "0-10",
    install_id: "install_0123456789abcdef",
    org_name: "Acme",
  });
  expect(Date.parse(posted[0]?.submitted_at ?? "")).toBeGreaterThan(openedAt);
  expect(container.textContent).toContain("What would make it a 10?");
});

test("the follow-up updates the same submission and reports the flags once", async () => {
  const container = await mount();
  await act(async () => button(container, "3")?.click());
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    textarea.value = "Setup was slow";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => form.requestSubmit());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.submission_id).toBe(posted[0]?.submission_id as string);
  expect(posted[1]).toMatchObject({ nps: 3, scale: "0-10", message: "Setup was slow" });
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([
    {
      event: "popup.submitted",
      properties: { popup: "feedback", score: 3, has_message: true, has_contact: false },
    },
  ]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test("an opted-out install sends no install ID and no org name", async () => {
  telemetry = false;
  const container = await mount();
  await act(async () => button(container, "10")?.click());
  expect(posted[0]).not.toHaveProperty("install_id");
  expect(posted[0]).not.toHaveProperty("org_name");
  expect(posted[0]).toMatchObject({ nps: 10, scale: "0-10" });
});

test("'Not now' before a score reports a dismissal", async () => {
  const container = await mount();
  await act(async () => button(container, "Not now")?.click());
  expect(events.at(-1)).toEqual({
    event: "popup.dismissed",
    properties: { popup: "feedback", method: "later" },
  });
  expect(posted).toEqual([]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

const storedState = () =>
  JSON.parse(Object.values({ ...localStorage }).find((v) => v.includes("submissionCount")) ?? "{}");

test("a rejected score is not recorded and a second tap retries the same submission", async () => {
  outcomes = ["error"];
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  expect(posted).toHaveLength(1);
  expect(container.textContent).not.toContain("your score is in");
  expect(button(container, "5")?.disabled).toBe(false);
  expect(storedState()).toMatchObject({ lastSubmittedAt: null, submissionCount: 0 });

  await act(async () => button(container, "8")?.click());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.submission_id).toBe(posted[0]?.submission_id as string);
  expect(container.textContent).toContain("your score is in");
  expect(storedState().submissionCount).toBe(1);
  expect(typeof storedState().lastSubmittedAt).toBe("string");
});

test("closing after a rejected score reports a dismissal, not a submission", async () => {
  outcomes = ["error"];
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  await act(async () => button(container, "Not now")?.click());
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ event: "popup.dismissed" });
  expect(storedState().submissionCount).toBe(0);
});

test("a score in flight blocks other taps and is recorded only once it lands", async () => {
  outcomes = ["defer"];
  const container = await mount();
  await act(async () => button(container, "6")?.click());
  await act(async () => button(container, "6")?.click());
  expect(posted).toHaveLength(1);
  expect(button(container, "2")?.disabled).toBe(true);
  expect(storedState().submissionCount).toBe(0);
  await act(async () => deferred.shift()?.());
  expect(storedState().submissionCount).toBe(1);
  expect(container.textContent).toContain("your score is in");
});
