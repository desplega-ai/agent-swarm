import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { SubmitImprovementInput } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

let submitted: SubmitImprovementInput[] = [];
let toasts: string[] = [];
let resultStatus = "sent";
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

mock.module("@/api/hooks/use-improvements", () => ({
  useSubmitImprovement: () => ({
    isPending: false,
    mutateAsync: async (input: SubmitImprovementInput) => {
      submitted.push(input);
      return { id: "i1", status: resultStatus };
    },
  }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1", user: { email: "dana@acme.com" } }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("sonner", () => ({
  toast: {
    success: (m: string) => toasts.push(m),
    error: (m: string) => toasts.push(m),
    info: (m: string) => toasts.push(m),
  },
}));
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: Box,
  DialogHeader: Box,
  DialogFooter: Box,
  DialogTitle: Box,
  DialogDescription: Box,
}));

const { ImprovementDialog, improvementPreview } = await import("./improvement-dialog");

let container: HTMLDivElement;
let unmount: () => Promise<void>;
let closed = 0;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ImprovementDialog open onOpenChange={(open) => !open && closed++} />),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

async function type(selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined;

beforeEach(async () => {
  submitted = [];
  toasts = [];
  closed = 0;
  resultStatus = "sent";
  await mount();
});
afterEach(async () => unmount());

test("the email defaults to the signed-in user and the preview shows the exact fields", async () => {
  const email = container.querySelector("#improvement-email") as HTMLInputElement;
  expect(email.value).toBe("dana@acme.com");
  await type("#improvement-text", "  Bulk retry  ");
  const preview = container.querySelector("pre")?.textContent ?? "";
  const parsed = JSON.parse(preview);
  expect(Object.keys(parsed).sort()).toEqual(["email", "install_id", "text"]);
  expect(parsed.text).toBe("Bulk retry");
  expect(parsed.email).toBe("dana@acme.com");
});

test("send is disabled until there is text, then submits with sendNow from the ui", async () => {
  expect(button("Send")?.disabled).toBe(true);
  await type("#improvement-text", "Bulk retry");
  await act(async () => button("Send")?.click());
  expect(submitted).toEqual([
    { text: "Bulk retry", email: "dana@acme.com", sendNow: true, source: "ui" },
  ]);
  expect(closed).toBe(1);
  expect(toasts[0]).toContain("sent");
});

test("a cleared email is not sent, and a redacted draft tells the person to review it", async () => {
  resultStatus = "pending_approval";
  await type("#improvement-text", "Bulk retry");
  await type("#improvement-email", "");
  expect(JSON.parse(container.querySelector("pre")?.textContent ?? "{}").email).toBeUndefined();
  await act(async () => button("Send")?.click());
  expect(submitted[0]?.email).toBeUndefined();
  expect(toasts[0]).toContain("redacted");
});

test("an invalid email blocks send", async () => {
  await type("#improvement-text", "Bulk retry");
  await type("#improvement-email", "not-an-email");
  expect(button("Send")?.disabled).toBe(true);
});

test("improvementPreview never adds fields beyond install_id, text and email", () => {
  expect(Object.keys(JSON.parse(improvementPreview("x", "")))).toEqual(["install_id", "text"]);
});
