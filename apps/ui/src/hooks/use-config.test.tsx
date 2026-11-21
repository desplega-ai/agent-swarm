import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:5274/" });
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

// `bun:test` runs from the repo root, so map the `@/` imports to the real files.
mock.module("@/lib/config", () => require("../lib/config"));
mock.module("@/lib/connection-url-params", () => require("../lib/connection-url-params"));
mock.module("@/lib/deployment-config", () => require("../lib/deployment-config"));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useConfigProvider } = await import("./use-config");
const { getActiveConnection, getEmbedConnection } = await import("../lib/config");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = {
  id: "conn_a",
  name: "Saved",
  apiUrl: "http://127.0.0.1:1",
  apiKey: "dummy-operator",
};
const EMBED_KEY = "agent-swarm-embed-connection";

type ConfigValue = ReturnType<typeof useConfigProvider>;

const realTop = Object.getOwnPropertyDescriptor(window, "top");

/** Make the page look framed (`window.self !== window.top`) or top-level. */
function setFramed(framed: boolean) {
  Object.defineProperty(window, "top", {
    configurable: true,
    get: () => (framed ? ({} as Window) : window),
  });
}

function mount(search: string): ConfigValue {
  window.history.replaceState({}, "", `/${search}`);
  let value: ConfigValue | null = null;
  function Probe() {
    value = useConfigProvider();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  act(() => root.unmount());
  if (!value) throw new Error("useConfigProvider did not render");
  return value;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    "agent-swarm-connections",
    JSON.stringify({ connections: [SAVED], activeId: SAVED.id }),
  );
  setFramed(false);
});

afterEach(() => {
  if (realTop) Object.defineProperty(window, "top", realTop);
});

describe("connection params in the dashboard URL", () => {
  test("a top-level aswt_ link does not switch the active connection without a click", () => {
    const value = mount("?apiUrl=http://127.0.0.1:2&apiKey=aswt_dummy");

    expect(sessionStorage.getItem(EMBED_KEY)).toBeNull();
    expect(getActiveConnection()?.apiUrl).toBe(SAVED.apiUrl);
    // It waits for the user's choice in the naming dialog instead.
    expect(value.pendingConnection).toEqual({ apiUrl: "http://127.0.0.1:2", apiKey: "aswt_dummy" });
  });

  test("a framed embed with a non-http(s) or userinfo URL is ignored", () => {
    setFramed(true);
    for (const apiUrl of ["ftp://127.0.0.1:2", "http://user:pass@127.0.0.1:2"]) {
      sessionStorage.clear();
      const value = mount(`?apiUrl=${encodeURIComponent(apiUrl)}&apiKey=aswt_dummy`);
      expect(sessionStorage.getItem(EMBED_KEY)).toBeNull();
      expect(value.pendingConnection).toBeNull();
      expect(getActiveConnection()?.apiUrl).toBe(SAVED.apiUrl);
    }
  });

  // Controls: these hold before and after the change.
  test("control: a framed aswt_ embed still connects without a prompt", () => {
    setFramed(true);
    const value = mount("?apiUrl=http://127.0.0.1:2/&apiKey=aswt_dummy");

    expect(getEmbedConnection()?.apiUrl).toBe("http://127.0.0.1:2");
    expect(getActiveConnection()?.apiUrl).toBe("http://127.0.0.1:2");
    expect(value.pendingConnection).toBeNull();
  });

  test("control: a top-level operator key waits for the naming dialog", () => {
    const value = mount("?apiUrl=http://127.0.0.1:2&apiKey=dummy-other");

    expect(sessionStorage.getItem(EMBED_KEY)).toBeNull();
    expect(getActiveConnection()?.apiUrl).toBe(SAVED.apiUrl);
    expect(value.pendingConnection).toEqual({
      apiUrl: "http://127.0.0.1:2",
      apiKey: "dummy-other",
    });
  });

  test("control: the URL params are dropped from the address bar", () => {
    mount("?apiUrl=http://127.0.0.1:2&apiKey=aswt_dummy&tab=x");
    expect(window.location.search).toBe("?tab=x");
  });
});
