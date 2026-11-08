import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

// Every `@/` specifier maps to its real file (bun does not resolve vite's alias).
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

const PAGE_ID = "8b8077e8b7a94dfc89c88636889a46ac";
let updatedAt = "2026-11-08T10:00:00.000Z";
let metadataCalls = 0;
const realClient = await import(join(SRC, "api/client.ts"));
const fakeApi = Object.assign(Object.create(realClient.api), {
  getPage: async () => ({ id: PAGE_ID, updatedAt, title: "Demo" }),
  fetchPageMetadata: async () => {
    metadataCalls++;
    return {
      id: PAGE_ID,
      version: 1,
      title: "Demo",
      description: null,
      contentType: "text/html",
      authMode: "public",
      body: "<h1>hi</h1>",
    };
  },
});
mock.module("@/api/client", () => ({ ...realClient, api: fakeApi }));

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ThemeProvider } = await import("@/hooks/use-theme");
const { swarmComponents } = await import("./components");

type Renderable = (arg: { props: unknown }) => ReactNode;
const PageFrame = swarmComponents.PageFrame as Renderable;

const roots: { unmount(): void }[] = [];
let client = new QueryClient();

beforeEach(() => {
  document.body.innerHTML = "";
  client = new QueryClient();
  metadataCalls = 0;
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter>
            <PageFrame props={props} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    ),
  );
  return host;
}

const revisionOf = (frame: Element | null) =>
  frame ? new URL(frame.getAttribute("src")!).searchParams.get("__swarm_revision") : null;

/** Lets the lazy page body and the queries settle until the frame shows `revision`. */
async function settle(host: HTMLElement, revision: string) {
  for (let i = 0; i < 50 && revisionOf(host.querySelector("iframe")) !== revision; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  return host.querySelector("iframe");
}

test("renders the page body in a sandboxed iframe and reloads when the page changes", async () => {
  const host = await mount({ pageId: PAGE_ID });
  const frame = await settle(host, updatedAt);
  expect(frame).not.toBeNull();
  const src = new URL(frame!.getAttribute("src")!);
  expect(src.pathname).toBe(`/p/${PAGE_ID}`);
  expect(revisionOf(frame)).toBe(updatedAt);
  expect(frame!.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(metadataCalls).toBe(1);

  updatedAt = "2026-11-08T10:00:05.000Z";
  await act(async () => {
    await client.refetchQueries({ queryKey: ["page-frame", PAGE_ID] });
  });
  const reloaded = await settle(host, updatedAt);
  expect(revisionOf(reloaded)).toBe(updatedAt);
  // A changed page also refetches the metadata the body renders from.
  expect(metadataCalls).toBe(2);
});

test("mobile narrows the frame to 390 px; an empty or bad id renders a state, no frame", async () => {
  const mobile = await mount({ pageId: PAGE_ID, device: "mobile" });
  const box = mobile.querySelector('[data-device="mobile"]') as HTMLElement;
  expect(box.style.width).toBe("390px");

  const empty = await mount({ pageId: "" });
  expect(empty.textContent).toContain("No page selected");
  const bad = await mount({ pageId: "../api/keys" });
  expect(bad.textContent).toContain("Not a page id");
  expect(bad.querySelector("iframe")).toBeNull();
});
