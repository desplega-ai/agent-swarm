import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

interface TestConnection {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
}

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const ACTIVE: TestConnection = {
  id: "a",
  name: "Acme swarm",
  apiUrl: "https://swarm.acme.com",
  apiKey: "aswt_abcd1234", // gitleaks:allow (fake test key)
};
let active: TestConnection | null = ACTIVE;
let connections: TestConnection[] = [ACTIVE];
let locked = false;
const removed: string[] = [];
const switched: string[] = [];

mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({
    activeConnection: active,
    connections,
    config: { apiUrl: active?.apiUrl ?? "", apiKey: active?.apiKey ?? "" },
    connectionLocked: locked,
    removeConnection: (id: string) => removed.push(id),
    switchConnection: (id: string) => switched.push(id),
  }),
}));
// The real module: a root `bun test` does not resolve the `@/` alias by itself.
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/card", () => ({
  Card: box,
  CardContent: box,
  CardDescription: box,
  CardHeader: box,
  CardTitle: box,
}));
mock.module("@/components/ui/spinner", () => ({ Spinner: () => <span>spinner</span> }));

const { AccessEndedScreen, accessEndedCopy } = await import("./access-ended-screen");

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  active = ACTIVE;
  connections = [ACTIVE];
  locked = false;
  removed.length = 0;
  switched.length = 0;
});

async function render(props: { checking?: boolean; onRetry?: () => void } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <AccessEndedScreen
        checking={props.checking ?? false}
        onRetry={props.onRetry ?? (() => {})}
      />,
    ),
  );
  return container;
}

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

describe("accessEndedCopy", () => {
  test("a user token: the admin suspended or revoked it", () => {
    const copy = accessEndedCopy("aswt_x", "Acme", false);
    expect(copy.title).toBe("Your access to Acme ended");
    expect(copy.description).toContain("suspended your user or revoked your token");
    expect(copy.description).toContain("new invite link");
  });

  test("an operator key: connect again with the new key", () => {
    const copy = accessEndedCopy("123123", "Acme", false);
    expect(copy.title).toBe("Acme does not accept the saved key");
    expect(copy.description).toContain("Connect again with the new key.");
  });

  test("a fixed deployment connection: ask the admin of this dashboard", () => {
    expect(accessEndedCopy("123123", "Acme", true).description).toContain(
      "Ask the admin of this dashboard",
    );
  });
});

describe("AccessEndedScreen", () => {
  test("names the swarm, retries, and removes this connection", async () => {
    let retries = 0;
    const view = await render({
      onRetry: () => {
        retries += 1;
      },
    });
    expect(view.textContent).toContain("Your access to Acme swarm ended");
    await act(async () => button("Try again").click());
    expect(retries).toBe(1);
    await act(async () => button("Remove from this browser").click());
    expect(removed).toEqual(["a"]);
    expect(view.textContent).not.toContain("Or open another swarm");
  });

  test("an embed connection shows the host, not its embed name", async () => {
    active = { ...ACTIVE, id: "embed", name: "embed:swarm.acme.com" };
    connections = [{ ...ACTIVE, id: "b", name: "Other" }];
    const view = await render();
    expect(view.textContent).toContain("Your access to swarm.acme.com ended");
    // The embed connection wins over the saved list: no switch.
    expect(view.textContent).not.toContain("Or open another swarm");
  });

  test("offers each other saved connection", async () => {
    const other = { id: "b", name: "Beta", apiUrl: "https://beta.example", apiKey: "123123" };
    connections = [ACTIVE, other];
    await render();
    await act(async () => button("Beta").click());
    expect(switched).toEqual(["b"]);
  });

  test("a fixed deployment connection offers no remove and no switch", async () => {
    locked = true;
    connections = [ACTIVE, { id: "b", name: "Beta", apiUrl: "https://b", apiKey: "k" }];
    const view = await render();
    expect(view.textContent).not.toContain("Remove from this browser");
    expect(view.textContent).not.toContain("Or open another swarm");
  });

  test("a running check disables Try again", async () => {
    await render({ checking: true });
    expect(button("Try again").disabled).toBe(true);
  });
});
