import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// react-dom and react-query must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, keepPreviousData, useQuery } = await import(
  "@tanstack/react-query"
);
const { deriveStorageKey } = await import("../../hooks/use-dismissible-card-key");
const { CURRENT_USER_CARD_KEY } = await import("../dashboard-user");
const { keepPreviousWithin, paletteSearchKey } = await import("./identity");
const { pushRecent, readRecents } = await import("./recents");
const { usePaletteIdentity } = await import("./use-palette-identity");

// Placeholder key built at runtime, so secret scanners see no literal.
const swarm = { apiUrl: "http://palette-identity.test", apiKey: `${"k".repeat(12)}1234` };
const USER_KEY = deriveStorageKey(swarm.apiUrl, CURRENT_USER_CARD_KEY);

/** Lets react-query settle and re-render. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Another tab picks a user: it writes storage, and this tab gets a `storage` event. */
async function switchUserInOtherTab(userId: string) {
  localStorage.setItem(USER_KEY, userId);
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY, newValue: userId }));
  });
  await flush();
}

/** Search answers per user. User b's never resolves, so a placeholder would show. */
function searchAs(user: string | null): Promise<string[]> {
  return user === "user-a" ? Promise.resolve(["a's private task"]) : new Promise(() => {});
}

// Mirrors `apiSearch` in components/command-palette/providers.tsx.
function Search({ keepAcrossUsers }: { keepAcrossUsers: boolean }) {
  const queryKey = paletteSearchKey(swarm, "tasks", "deploy", 5);
  const { data } = useQuery({
    queryKey,
    queryFn: () => searchAs(localStorage.getItem(USER_KEY)),
    placeholderData: keepAcrossUsers ? keepPreviousData : keepPreviousWithin(queryKey[1]),
  });
  return <output data-testid="results">{(data ?? []).join(",")}</output>;
}

// Mirrors `PaletteBody`: recents read once, at mount.
function Body() {
  const [recents] = useState(() => readRecents(swarm));
  return <output data-testid="recents">{recents.map((r) => r.title).join(",")}</output>;
}

interface Options {
  /** Key the body by identity, as `PaletteSession` does. */
  remount?: boolean;
  keepAcrossUsers?: boolean;
}

// Mirrors `PaletteSession` in components/shared/command-menu.tsx.
function Session({ remount = true, keepAcrossUsers = false }: Options) {
  const identity = usePaletteIdentity(() => swarm);
  return (
    <div key={remount ? identity : "fixed"}>
      <Body />
      <Search keepAcrossUsers={keepAcrossUsers} />
    </div>
  );
}

async function mount(options: Options = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Session {...options} />
      </QueryClientProvider>,
    ),
  );
  await flush();
  const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
  return { text, unmount: () => act(async () => root.unmount()) };
}

describe("open palette, user switched in another tab", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(USER_KEY, "user-a");
    pushRecent(swarm, { kind: "tasks", title: "a's recent", href: "/tasks/a" });
  });

  test("the first user's recents and results leave the screen", async () => {
    const palette = await mount();
    expect(palette.text("recents")).toBe("a's recent");
    expect(palette.text("results")).toBe("a's private task");

    await switchUserInOtherTab("user-b");
    expect(palette.text("recents")).toBe("");
    expect(palette.text("results")).toBe("");
    await palette.unmount();
  });

  test("without the remount, results still never cross users", async () => {
    const palette = await mount({ remount: false });
    expect(palette.text("results")).toBe("a's private task");

    await switchUserInOtherTab("user-b");
    expect(palette.text("results")).toBe("");
    await palette.unmount();
  });

  test("control: without either guard, plain keepPreviousData shows the first user's results", async () => {
    const palette = await mount({ remount: false, keepAcrossUsers: true });
    expect(palette.text("results")).toBe("a's private task");

    await switchUserInOtherTab("user-b");
    expect(palette.text("recents")).toBe("a's recent");
    expect(palette.text("results")).toBe("a's private task");
    await palette.unmount();
  });

  test("a storage write that changes no identity keeps the palette", async () => {
    const palette = await mount();
    await act(async () => {
      localStorage.setItem("unrelated", "1");
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "1" }));
    });
    expect(palette.text("recents")).toBe("a's recent");
    expect(palette.text("results")).toBe("a's private task");
    await palette.unmount();
  });
});
