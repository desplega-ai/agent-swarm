import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const steers: Array<Record<string, unknown>> = [];

mock.module("@/api/hooks/use-tasks", () => ({
  useSteerTask: () => ({
    isPending: false,
    isError: false,
    error: null,
    mutate: (input: Record<string, unknown>) => steers.push(input),
  }),
}));
mock.module("sonner", () => ({ toast: { success: () => {} } }));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
// The real grants hook: outside a provider it answers "operator tab".
mock.module("@/lib/use-can", () => require("../../lib/use-can"));
mock.module("@/lib/composer-citations", () => require("../../lib/composer-citations"));
mock.module("./steer-mode-toggle", () => ({ SteerModeToggle: () => null }));
// Uploads succeed with a fresh id, except a file named "broken.png".
const uploaded: string[] = [];
const deleted: string[] = [];
mock.module("@/api/fs", () => ({
  uploadTaskAttachment: async ({ taskId, file }: { taskId: string; file: File }) => {
    if (file.name === "broken.png") throw new Error("upload failed");
    uploaded.push(`${taskId}/${file.name}`);
    return { id: `att-${file.name}`, taskId, name: file.name };
  },
  deleteTaskAttachment: async (taskId: string, id: string) => {
    deleted.push(`${taskId}/${id}`);
  },
}));
mock.module("@/components/sessions/compose-attachment-upload", () =>
  require("../sessions/compose-attachment-upload"),
);
// The dock has its own tests; the stub sends whatever is in the box.
mock.module("@/components/sessions/composer-dock", () => ({
  ComposerDock: (props: {
    value: string;
    onSubmit: () => void;
    attachmentErrorMessage?: string | null;
  }) => (
    <button
      type="button"
      aria-label="Send"
      data-value={props.value}
      data-error={props.attachmentErrorMessage ?? ""}
      onClick={props.onSubmit}
    />
  ),
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { SteerComposer } = await import("./steer-composer");

beforeEach(() => {
  steers.length = 0;
  uploaded.length = 0;
  deleted.length = 0;
  document.body.innerHTML = "";
});

async function sendFrom(node: React.ReactNode): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  // The upload resolves after the click.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const error = (host.querySelector("button") as HTMLButtonElement).dataset.error ?? "";
  await act(async () => root.unmount());
  return error;
}

const png = (name: string) => new File([new Uint8Array([1])], name, { type: "image/png" });

test("a steer carries the given source", async () => {
  await sendFrom(<SteerComposer taskId="t1" value="faster" source="app-page" />);
  expect(steers).toEqual([
    expect.objectContaining({ id: "t1", message: "faster", mode: "queue", source: "app-page" }),
  ]);
});

test("without a source the steer leaves it to the client's default", async () => {
  await sendFrom(<SteerComposer taskId="t1" value="faster" />);
  expect(steers).toHaveLength(1);
  expect(steers[0]?.source).toBeUndefined();
});

test("steering sends cited excerpts with the draft", async () => {
  await sendFrom(
    <SteerComposer
      taskId="t1"
      value="Check this again"
      citations={{ quotes: ["Rebuild paused"], remove: () => {}, clear: () => {} }}
    />,
  );
  expect(steers[0]?.message).toBe("> Rebuild paused\n\nCheck this again");
});

test("files upload to the steered task and go out as attachment ids", async () => {
  await sendFrom(
    <SteerComposer
      taskId="t1"
      value="see these"
      attachments={[png("a.png"), png("b.png")]}
      onAttachmentsChange={() => {}}
    />,
  );
  expect(uploaded.sort()).toEqual(["t1/a.png", "t1/b.png"]);
  expect(steers).toEqual([
    expect.objectContaining({
      id: "t1",
      message: "see these",
      attachmentIds: ["att-a.png", "att-b.png"],
    }),
  ]);
});

test("a failed upload sends nothing and withdraws the files that did upload", async () => {
  const error = await sendFrom(
    <SteerComposer
      taskId="t1"
      value="see these"
      attachments={[png("a.png"), png("broken.png")]}
      onAttachmentsChange={() => {}}
    />,
  );
  expect(steers).toEqual([]);
  expect(deleted).toEqual(["t1/att-a.png"]);
  expect(error).toBe("broken.png failed to upload, so nothing was sent. Send again to retry.");
});
