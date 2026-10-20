import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { FeedbackInput } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: "test" });
const { createRoot } = await import("react-dom/client");

let telemetry = true;
/** Outcomes for the next requests, in order; empty means success. */
let outcomes: Array<"error" | "defer" | "defer-error"> = [];
let deferred: Array<() => void> = [];
const posted: FeedbackInput[] = [];
const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
/** What the stub QuestionFlow submits. */
let flowValues: Record<string, unknown> = {};
let storedTeamSize: string | null = null;
const saves: Array<{ patch: Record<string, unknown>; surface: string }> = [];
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
    mutateAsync: async (input: FeedbackInput) => {
      posted.push(input);
      const outcome = outcomes.shift();
      if (outcome === "error") throw new Error("proxy down");
      if (outcome === "defer") await new Promise<void>((resolve) => deferred.push(resolve));
      if (outcome === "defer-error") {
        await new Promise<void>((_, reject) =>
          deferred.push(() => reject(new Error("proxy down"))),
        );
      }
    },
  }),
}));
mock.module("@/api/hooks/use-company-profile", () => ({
  useCompanyProfile: () => ({
    useCase: null,
    teamSize: storedTeamSize,
    acquisitionSource: null,
    save: async (patch: Record<string, unknown>, surface: string) => {
      saves.push({ patch, surface });
      return Object.keys(patch).map((key) => (key === "useCase" ? "use_case" : "team_size"));
    },
  }),
}));
// The shared flow is tested on its own: this stub lists the cards and submits `flowValues`.
mock.module("@/components/shared/question-flow", () => ({
  QuestionFlow: ({
    questions,
    footer,
    done,
    onSubmit,
  }: {
    questions: Array<{ id: string; label: string }>;
    footer?: ReactNode;
    done?: (values: Record<string, unknown>) => ReactNode;
    onSubmit: (values: Record<string, unknown>) => Promise<void>;
  }) => {
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (sent) return <div>{done?.(flowValues)}</div>;
    return (
      <div>
        {questions.map((question) => (
          <p key={question.id} data-question={question.id}>
            {question.label}
          </p>
        ))}
        {footer}
        {error ? <p role="alert">{error}</p> : null}
        <button
          type="button"
          onClick={() =>
            onSubmit(flowValues).then(
              () => setSent(true),
              (reason: Error) => setError(reason.message),
            )
          }
        >
          Submit
        </button>
      </div>
    );
  },
}));
mock.module("@/components/shared/setup-chip", () => ({ SetupChip: Box }));
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
}));
mock.module("@/components/shared/border-beam", () => ({ BorderBeam: () => null }));
mock.module("@/components/shared/status-icon", () => ({ StatusLine: Box }));
mock.module("@/lib/company-profile", () => require("../../lib/company-profile"));
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
  useCurrentUser: () => ({
    state: "ready",
    userId: "admin",
    user: { role: "admin", name: "Dana Kim", email: "dana@acme.com" },
  }),
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
mock.module("@/components/ui/input", () => ({
  Input: ({ id, value }: { id?: string; value?: string }) => <input id={id} defaultValue={value} />,
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
  flowValues = {};
  storedTeamSize = null;
  saves.length = 0;
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

test("shows the 0-10 scale with no Submit until a score is picked", async () => {
  const container = await mount();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button(container, "0")).toBeDefined();
  expect(button(container, "10")).toBeDefined();
  expect(button(container, "Submit")).toBeUndefined();
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
    org_name: "Acme",
  });
  expect(Date.parse(posted[0]?.submitted_at ?? "")).toBeGreaterThan(openedAt);
  expect(container.textContent).toContain("What would make it a 10?");
});

test("the follow-up updates the same submission, saves the profile and locks the grid", async () => {
  const container = await mount();
  await act(async () => button(container, "3")?.click());
  flowValues = { message: "Setup was slow", use_case: "bugs", team_size: "2-10" };
  await act(async () => button(container, "Submit")?.click());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.submission_id).toBe(posted[0]?.submission_id as string);
  expect(posted[1]).toMatchObject({
    nps: 3,
    scale: "0-10",
    message: "Setup was slow",
    use_case: "bugs",
    team_size: "2-10",
  });
  expect(posted[1]).not.toHaveProperty("email");
  expect(posted[1]).not.toHaveProperty("name");
  expect(saves).toEqual([{ patch: { useCase: "bugs", teamSize: "2-10" }, surface: "feedback" }]);
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([
    {
      event: "popup.submitted",
      properties: {
        popup: "feedback",
        score: 3,
        has_message: true,
        has_contact: false,
        answered: 2,
      },
    },
  ]);
  expect(container.textContent).toContain("Saved to your swarm profile");
  expect(button(container, "9")?.disabled).toBe(true);
});

test("another tap before Submit re-sends the same submission and the question follows", async () => {
  const container = await mount();
  await act(async () => button(container, "3")?.click());
  expect(container.textContent).toContain("What almost made you give up?");
  await act(async () => button(container, "9")?.click());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.submission_id).toBe(posted[0]?.submission_id as string);
  expect(posted[1]).toMatchObject({ nps: 9 });
  expect(container.textContent).toContain("What would you tell a colleague?");
  expect(storedState().submissionCount).toBe(1);
});

test("the one-tap profile questions come first and the message last", async () => {
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  expect(
    [...container.querySelectorAll("[data-question]")].map((el) =>
      el.getAttribute("data-question"),
    ),
  ).toEqual(["use_case", "team_size", "acquisition_source", "message"]);
});

test("a message over 6,000 UTF-8 bytes is refused at Submit with a reason", async () => {
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  // 3,001 characters, but 6,002 bytes: the proxy limit counts bytes.
  flowValues = { message: "é".repeat(3001) };
  await act(async () => button(container, "Submit")?.click());
  expect(posted).toHaveLength(1);
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Too long to send. Shorten it.",
  );
});

test("a message of exactly 6,000 bytes is sent", async () => {
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  flowValues = { message: "x".repeat(6000) };
  await act(async () => button(container, "Submit")?.click());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.message).toHaveLength(6000);
});

const pressEscape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

test("Escape while the follow-up sends waits for it, then reports its flags", async () => {
  const container = await mount();
  await act(async () => button(container, "7")?.click());
  outcomes = ["defer"];
  flowValues = { message: "More docs", use_case: "docs" };
  await act(async () => button(container, "Submit")?.click());
  await act(async () => pressEscape());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([]);
  await act(async () => deferred.shift()?.());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([
    {
      event: "popup.submitted",
      properties: {
        popup: "feedback",
        score: 7,
        has_message: true,
        has_contact: false,
        answered: 1,
      },
    },
  ]);
});

test("Escape during a follow-up that then fails keeps the card and its answers", async () => {
  const container = await mount();
  await act(async () => button(container, "7")?.click());
  outcomes = ["defer-error"];
  flowValues = { message: "More docs" };
  await act(async () => button(container, "Submit")?.click());
  await act(async () => pressEscape());
  await act(async () => deferred.shift()?.());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button(container, "Submit")).toBeDefined();
  expect(events.filter((e) => e.event === "popup.submitted")).toEqual([]);
});

test("a stored answer is not asked again", async () => {
  storedTeamSize = "2-10";
  const container = await mount();
  await act(async () => button(container, "8")?.click());
  expect(container.querySelector('[data-question="use_case"]')).not.toBeNull();
  expect(container.querySelector('[data-question="team_size"]')).toBeNull();
  expect(container.querySelector('[data-question="acquisition_source"]')).not.toBeNull();
});

test("Reply to me adds the name and email; unchecked, nothing personal is sent", async () => {
  const container = await mount();
  await act(async () => button(container, "10")?.click());
  expect(document.getElementById("feedback-email")).toBeNull();
  const reply = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Reply to me"),
  );
  const checkbox = reply?.querySelector("input") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  expect((document.getElementById("feedback-email") as HTMLInputElement).value).toBe(
    "dana@acme.com",
  );
  await act(async () => button(container, "Submit")?.click());
  expect(posted[1]).toMatchObject({ name: "Dana Kim", email: "dana@acme.com" });
  expect(events.at(-1)).toMatchObject({
    event: "popup.submitted",
    properties: { has_contact: true, answered: 0 },
  });
});

// `useSubmitFeedback` owns the install ID gating (use-feedback.test.ts).
test("an opted-out install sends no org name", async () => {
  telemetry = false;
  const container = await mount();
  await act(async () => button(container, "10")?.click());
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
  expect(container.textContent).not.toContain("Your score is in");
  expect(button(container, "5")?.disabled).toBe(false);
  expect(storedState()).toMatchObject({ lastSubmittedAt: null, submissionCount: 0 });

  await act(async () => button(container, "8")?.click());
  expect(posted).toHaveLength(2);
  expect(posted[1]?.submission_id).toBe(posted[0]?.submission_id as string);
  expect(container.textContent).toContain("Your score is in");
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
  expect(container.textContent).toContain("Your score is in");
});
