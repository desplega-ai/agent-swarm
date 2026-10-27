import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register({ url: "http://localhost:5274/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const added: { name: string; apiUrl: string; apiKey: string }[] = [];
const switched: string[] = [];
const exchanged: string[] = [];

mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({
    addConnection: (conn: { name: string; apiUrl: string; apiKey: string }) => {
      added.push(conn);
      return { id: "joined" };
    },
    switchConnection: (id: string) => switched.push(id),
  }),
}));
mock.module("@/lib/config", () => ({ connectionsManagedByDeployment: () => false }));
mock.module("./join-api", () => ({
  exchangeInviteCode: async (swarm: string, code: string) => {
    exchanged.push(`${swarm}|${code}`);
    return { token: "aswt_joined", userId: "u1" }; // gitleaks:allow (fake test token)
  },
  fetchCombEnabled: async () => false,
}));
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    asChild,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    asChild?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <button type="button" onClick={onClick}>
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
mock.module("@/components/ui/alert-callout", () => ({ AlertCallout: box }));

const { default: JoinPage } = await import("./page");

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  added.length = 0;
  switched.length = 0;
  exchanged.length = 0;
});

async function open(url: string) {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MemoryRouter>
        <JoinPage />
      </MemoryRouter>,
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

describe("JoinPage", () => {
  test("a crafted link saves and switches nothing until the teammate clicks Join", async () => {
    const view = await open("/join?swarm=https://attacker.example#code=abc123");
    expect(view.textContent).toContain("Join attacker.example?");
    expect(view.textContent).toContain("https://attacker.example");
    expect(exchanged).toEqual([]);
    expect(added).toEqual([]);
    expect(switched).toEqual([]);
    // The code left the address bar before any click.
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  test("Join trades the code, then saves and switches to the connection", async () => {
    await open("/join?swarm=https://swarm.acme.com/#code=abc123");
    await act(async () => button("Join swarm").click());
    expect(exchanged).toEqual(["https://swarm.acme.com|abc123"]);
    expect(added).toEqual([
      { name: "swarm.acme.com", apiUrl: "https://swarm.acme.com", apiKey: "aswt_joined" },
    ]);
    expect(switched).toEqual(["joined"]);
  });
});
