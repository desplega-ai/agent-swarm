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
mock.module("./steer-mode-toggle", () => ({ SteerModeToggle: () => null }));
// The dock has its own tests; the stub sends whatever is in the box.
mock.module("@/components/sessions/composer-dock", () => ({
  ComposerDock: (props: { value: string; onSubmit: () => void }) => (
    <button type="button" aria-label="Send" data-value={props.value} onClick={props.onSubmit} />
  ),
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { SteerComposer } = await import("./steer-composer");

beforeEach(() => {
  steers.length = 0;
  document.body.innerHTML = "";
});

async function sendFrom(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  await act(async () => root.unmount());
}

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
