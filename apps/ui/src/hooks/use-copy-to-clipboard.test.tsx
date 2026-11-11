import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React DOM must detect the browser after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { useCopyToClipboard } = await import("./use-copy-to-clipboard");

type Copy = (value: string, key?: "redirect" | "webhook") => Promise<boolean>;
let copy!: Copy;
let copiedKey: string | null = null;

function Probe() {
  const result = useCopyToClipboard<"redirect" | "webhook">();
  copy = result.copy;
  copiedKey = result.copiedKey;
  return null;
}

// Each writeText call is held until the test settles it, so the test controls
// resolution order. `mode` decides how the next pending write settles.
type Pending = { value: string; resolve: () => void; reject: () => void };
const pending: Pending[] = [];
function deferredWrite(value: string) {
  return new Promise<void>((resolve, reject) => {
    pending.push({ value, resolve, reject });
  });
}

// Save whatever `navigator.clipboard` was so we can restore it after the suite.
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (value: string) => deferredWrite(value) },
  });
});

afterAll(async () => {
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
  await GlobalRegistrator.unregister();
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  pending.length = 0;
  copiedKey = null;
});

test("an older copy resolving late does not overwrite the newer copiedKey", async () => {
  await mount();

  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = copy("first-value", "redirect");
  });
  await act(async () => {
    second = copy("second-value", "webhook");
  });

  // Resolve the newer write first, then the older one.
  await act(async () => {
    pending[1]?.resolve();
    await second;
  });
  await act(async () => {
    pending[0]?.resolve();
    await first;
  });

  expect(copiedKey).toBe("webhook");
});

test("a failed newer copy returns false and keeps the last successful copiedKey", async () => {
  await mount();

  // First copy succeeds and becomes the last successful copy.
  let ok!: Promise<boolean>;
  await act(async () => {
    ok = copy("first-value", "redirect");
  });
  await act(async () => {
    pending[0]?.resolve();
    await ok;
  });
  expect(copiedKey).toBe("redirect");

  // Newer copy fails: its write rejects.
  let failed!: Promise<boolean>;
  await act(async () => {
    failed = copy("second-value", "webhook");
  });
  let result: boolean | undefined;
  await act(async () => {
    pending[1]?.reject();
    result = await failed;
  });

  expect(result).toBe(false);
  expect(copiedKey).toBe("redirect");
});
