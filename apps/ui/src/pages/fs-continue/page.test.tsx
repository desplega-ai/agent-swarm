import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

GlobalRegistrator.register({ url: "http://localhost:5274/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");

class FsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
let fsContinue: (data: { returnTo: string }) => Promise<{ redirectUrl: string }> = async () => {
  throw new Error("not stubbed");
};
mock.module("@/api/client", () => ({
  api: { fsContinue: (data: { returnTo: string }) => fsContinue(data) },
  FsApiError,
}));
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => children,
}));
mock.module("@/components/ui/card", () => ({
  Card: box,
  CardContent: box,
  CardDescription: box,
  CardHeader: box,
  CardTitle: box,
}));
mock.module("@/components/ui/alert-callout", () => ({ AlertCallout: box }));

const { default: FsContinuePage } = await import("./page");

const originalReplace = window.location.replace;
const calls: string[] = [];
const replaced: string[] = [];

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  calls.length = 0;
  replaced.length = 0;
  Object.defineProperty(window.location, "replace", {
    configurable: true,
    value: originalReplace,
  });
});

function stubApi(result: () => Promise<{ redirectUrl: string }>) {
  fsContinue = async ({ returnTo }) => {
    calls.push(returnTo);
    return result();
  };
  Object.defineProperty(window.location, "replace", {
    configurable: true,
    value: (url: string) => replaced.push(url),
  });
}

async function open(url: string) {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MemoryRouter>
        <FsContinuePage />
      </MemoryRouter>,
    ),
  );
  return container;
}

const live = "https://live.agent-fs.dev/file/~/org/drive/x.md";

describe("FsContinuePage", () => {
  test("mints once and replaces the location with the fragment URL", async () => {
    const redirectUrl = `${live}#key=af_example&apiUrl=${encodeURIComponent("https://swarm.example.test/agentfs")}`;
    stubApi(async () => ({ redirectUrl }));
    const view = await open(`/fs/continue?return_to=${encodeURIComponent(live)}`);
    expect(calls).toEqual([live]);
    expect(replaced).toEqual([redirectUrl]);
    expect(view.textContent).toContain("Continuing to live.agent-fs.dev");
  });

  test("an API error shows its message and a link to the files", async () => {
    stubApi(async () => {
      throw new FsApiError("invalid_return_to", 400);
    });
    const view = await open(`/fs/continue?return_to=${encodeURIComponent(live)}`);
    expect(replaced).toEqual([]);
    expect(view.textContent).toContain("Could not continue to live.agent-fs.dev");
    expect(view.textContent).toContain("does not point to your agent-fs app");
    expect(view.querySelector('a[href="/file"]')).not.toBeNull();
  });

  test("pending and old agent-fs servers get their own message", async () => {
    for (const [status, text] of [
      [409, "not ready yet"],
      [501, "too old"],
    ] as const) {
      stubApi(async () => {
        throw new FsApiError("x", status);
      });
      const view = await open(`/fs/continue?return_to=${encodeURIComponent(live)}`);
      expect(view.textContent).toContain(text);
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
    }
  });

  test("a missing or invalid return_to calls nothing", async () => {
    stubApi(async () => ({ redirectUrl: "unused" }));
    for (const url of ["/fs/continue", "/fs/continue?return_to=not-a-url"]) {
      const view = await open(url);
      expect(view.textContent).toContain("Link incomplete");
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
    }
    expect(calls).toEqual([]);
  });
});
