import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => GlobalRegistrator.unregister());

// Excalidraw and the chrome are mocked; ObjectViewer, ObjectEmbed, useObject
// and BoardView are real.
type Props = Record<string, any>;
const ID = "board-1";
const CONTENT = { type: "excalidraw", swarm: { id: ID }, elements: [], appState: {} };
let writes = 0;

mock.module("@excalidraw/excalidraw", () => ({
  Excalidraw: (p: Props) => {
    const { useEffect, useRef } = require("react");
    const scene = useRef({ elements: [...p.initialData.elements], appState: {} });
    useEffect(() => {
      p.excalidrawAPI({
        getSceneElements: () => scene.current.elements,
        getAppState: () => scene.current.appState,
        getFiles: () => ({}),
        refresh: () => {},
      });
      p.onChange(scene.current.elements, scene.current.appState);
    }, []);
    const add = () => {
      scene.current.elements.push({ id: `shape-${scene.current.elements.length}`, version: 1 });
      p.onChange(scene.current.elements, scene.current.appState);
    };
    return (
      <button type="button" onClick={add}>
        Add shape ({scene.current.elements.length})
      </button>
    );
  },
  CaptureUpdateAction: { NEVER: "NEVER" },
  hashElementsVersion: (e: unknown[]) => JSON.stringify(e),
  restoreElements: (e: unknown[]) => e,
  restoreAppState: (a: Props) => a,
  serializeAsJSON: (elements: unknown[], appState: Props) => JSON.stringify({ elements, appState }),
}));
mock.module("@excalidraw/excalidraw/index.css", () => ({}));
mock.module("@/api/client", () => ({
  api: {
    fetchApi: async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes++;
        return Response.json({ version: 2 });
      }
      return Response.json({
        object: { id: ID, kind: "board", fileVersion: 1 },
        version: 1,
        unchanged: false,
        content: CONTENT,
      });
    },
  },
}));
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAgentFsText: () => ({ data: { text: JSON.stringify(CONTENT) } }),
}));
mock.module("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: "light" }) }));
mock.module("@/lib/use-can", () => ({ useCan: () => true }));
mock.module("@/lib/comb/file-kinds", () => require("../../../lib/comb/file-kinds"));
mock.module("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({ options, onValueChange }: Props) => (
    <div>
      {options.map((o: Props) => (
        <button type="button" key={o.value} onClick={() => onValueChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  ),
}));
mock.module("@/components/ui/button", () => ({
  Button: ({ size: _s, variant: _v, ...p }: Props) => <button type="button" {...p} />,
}));
mock.module("@/components/shared/empty-state", () => ({ EmptyState: () => null }));
mock.module("@/components/shared/copy-value-button", () => ({ CopyValueButton: () => null }));
mock.module("@/components/ui/alert-callout", () => ({ AlertCallout: () => null }));
mock.module("@/components/ui/skeleton", () => ({ Skeleton: () => null }));
mock.module("@/components/objects/object-embed", () => require("../../objects/object-embed"));
mock.module("./text-viewer", () => ({ default: () => <div>Source text</div> }));
mock.module("./fallback-viewer", () => ({ default: () => null }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AUTOSAVE_MS } = await import("../../objects/board-view");
const { default: ObjectViewer } = await import("./object-viewer");

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
});

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <ObjectViewer
        file={{ orgId: "org", driveId: "drive", path: "plan.excalidraw" } as Props as never}
        stat={{ size: 10, contentType: "application/json" } as never}
      />,
    );
  });
  for (let i = 0; i < 40 && !host.textContent?.includes("Add shape"); i++) await wait(25);
  const button = (prefix: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(prefix));
  const click = (prefix: string) =>
    act(async () => {
      const b = button(prefix);
      expect(b).toBeDefined();
      b?.click();
    });
  return { host, button, click };
}

test("control: an edit left on the Board view autosaves once", async () => {
  writes = 0;
  const { click } = await mount();
  await click("Add shape");
  await wait(AUTOSAVE_MS + 250);
  expect(writes).toBe(1);
});

test("Source before the autosave timer still saves the edit, and Board shows it", async () => {
  writes = 0;
  const { click, button, host } = await mount();
  await click("Add shape");
  await click("Source");
  expect(host.textContent).toContain("Source text");
  await wait(AUTOSAVE_MS + 250);
  expect(writes).toBe(1);
  await click("Board");
  expect(host.textContent).not.toContain("Source text");
  expect(button("Add shape")?.textContent).toBe("Add shape (1)");
});
