import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  url: "https://api.example.test/p/page-1",
  settings: { handleDisabledFileLoadingAsSuccess: true },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => GlobalRegistrator.unregister());

// ObjectEmbed is mocked: these tests cover the element, its viewer gate and its fetch.
type EmbedProps = Record<string, any>;
let embedProps: EmbedProps | null = null;
mock.module("@/components/objects/object-embed", () => ({
  ObjectEmbed: (p: EmbedProps) => {
    embedProps = p;
    return null;
  },
}));

const { act } = await import("react");
const { currentPageId, defineSwarmObject, pageObjectFetch, readPageViewer } = await import(
  "./swarm-object-element"
);

defineSwarmObject({
  stylesheet: "https://ui.example.test/embed/v1/swarm-object.css",
  documentStylesheet: "https://ui.example.test/embed/v1/swarm-object-global.css",
  appOrigin: "https://ui.example.test",
});

const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("{}");
  }) as typeof fetch;
});
/** Removing the element unmounts its React root; inside act, so no work outlives the test. */
const clearBody = () =>
  act(async () => {
    document.body.innerHTML = "";
  });

afterEach(async () => {
  await clearBody();
  globalThis.fetch = realFetch;
  document.head.querySelector('meta[name="swarm-viewer"]')?.remove();
  document.documentElement.classList.remove("dark");
  embedProps = null;
});

function setViewer(viewer: string) {
  const meta = document.createElement("meta");
  meta.name = "swarm-viewer";
  meta.content = viewer;
  document.head.append(meta);
}

async function mount(attrs: string) {
  await act(async () => {
    document.body.innerHTML = `<swarm-object ${attrs}></swarm-object>`;
    // The element paints after its shadow stylesheet settles (load or error).
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return document.querySelector("swarm-object") as HTMLElement;
}

test("a guest sees the sign-in placeholder and sends no request", async () => {
  const el = await mount('object-id="obj-1"');
  const placeholder = el.shadowRoot?.querySelector("[data-swarm-object-placeholder]");
  expect(placeholder?.textContent).toContain("Sign in to the swarm to view");
  expect(placeholder?.querySelector("a")?.getAttribute("href")).toBe(
    "https://ui.example.test/pages/page-1",
  );
  expect(embedProps).toBeNull();
  expect(calls).toEqual([]);
});

test("a signed-in viewer gets ObjectEmbed with the attributes", async () => {
  setViewer("user");
  document.documentElement.classList.add("dark");
  await mount('object-id="obj-1" height="5000" tab="Tasks" range="B2:C3"');
  expect(embedProps).toMatchObject({
    objectId: "obj-1",
    height: 1200,
    readOnly: false,
    tab: "Tasks",
    range: "B2:C3",
    theme: "dark",
  });
});

test("readonly and an operator launch both make the embed read-only", async () => {
  setViewer("user");
  await mount('object-id="obj-1" readonly');
  expect(embedProps?.readOnly).toBe(true);
  await clearBody();
  document.head.querySelector('meta[name="swarm-viewer"]')?.remove();
  setViewer("operator");
  await mount('object-id="obj-1"');
  expect(embedProps?.readOnly).toBe(true);
});

test("an attribute change re-renders the embed", async () => {
  setViewer("user");
  const el = await mount('object-id="obj-1"');
  await act(async () => el.setAttribute("object-id", "obj-2"));
  expect(embedProps?.objectId).toBe("obj-2");
});

test("the shadow root links the stylesheet; the document gets the global sheet once", async () => {
  const el = await mount('object-id="obj-1"');
  expect(el.shadowRoot?.querySelector("link")?.getAttribute("href")).toBe(
    "https://ui.example.test/embed/v1/swarm-object.css",
  );
  await mount('object-id="obj-2"');
  expect(document.head.querySelectorAll('link[href$="swarm-object-global.css"]').length).toBe(1);
});

test("the page fetch goes through the same-origin proxy with the page id", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return new Response("{}");
  }) as typeof fetch;
  await pageObjectFetch("page-1")("/api/objects/obj-1/sheet-ops", {
    method: "POST",
    body: "{}",
  });
  const got = seen as { url: string; init?: RequestInit } | null;
  expect(got?.url).toBe("/@swarm/api/objects/obj-1/sheet-ops");
  const headers = new Headers(got?.init?.headers);
  expect(headers.get("X-Swarm-Page-Id")).toBe("page-1");
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(got?.init?.credentials).toBe("same-origin");
});

test("viewer meta and page id parsing", () => {
  expect(readPageViewer()).toBe("guest");
  setViewer("operator");
  expect(readPageViewer()).toBe("operator");
  document.head.querySelector('meta[name="swarm-viewer"]')?.remove();
  setViewer("admin");
  expect(readPageViewer()).toBe("guest");
  expect(currentPageId("/p/abc.json")).toBe("abc");
  expect(currentPageId("/pages/abc")).toBe("");
});
