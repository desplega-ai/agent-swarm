import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
mock.module("@/lib/utils", () => require("../../lib/utils"));
const { MiddleTruncation } = await import("./middle-truncation");
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 100 });

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let resize: ResizeObserverCallback;
let container: HTMLDivElement;
let root: Root;
const onTruncatedChange = mock();

beforeEach(() => {
  jest.useFakeTimers();
  frames.clear();
  onTruncatedChange.mockClear();
  spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  spyOn(globalThis, "ResizeObserver").mockImplementation((callback) => {
    resize = callback;
    return { observe() {}, unobserve() {}, disconnect() {} };
  });
  spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as CanvasRenderingContext2D);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
  mock.restore();
});

afterAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
  await GlobalRegistrator.unregister();
});

async function render(text: string) {
  await act(async () => {
    root.render(<MiddleTruncation onTruncatedChange={onTruncatedChange}>{text}</MiddleTruncation>);
  });
}

function triggerResize(width: number) {
  resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
}

async function advance(ms: number) {
  await act(async () => jest.advanceTimersByTime(ms));
}

async function paint() {
  await act(async () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  });
}

describe("MiddleTruncation resize cleanup", () => {
  test.each([0, 150])("keeps new text when rerendered %i ms after resize", async (elapsed) => {
    await render("aaaaaaaaaaaaaaaaaaaa");
    triggerResize(80);
    await advance(elapsed);

    await render("bbbbbbbbbbbbbbbbbbbb");
    expect(container.textContent).toBe("bbb...bbbb");
    onTruncatedChange.mockClear();
    await advance(150);
    await paint();

    expect(container.textContent).toBe("bbb...bbbb");
    expect(onTruncatedChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  test.each([0, 150])("cancels pending work on unmount %i ms after resize", async (elapsed) => {
    await render("aaaaaaaaaaaaaaaaaaaa");
    triggerResize(80);
    await advance(elapsed);
    await act(async () => root.unmount());
    onTruncatedChange.mockClear();

    await advance(150);
    await paint();
    expect(onTruncatedChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  test("recalculates on the frame after the latest resize debounce expires", async () => {
    await render("abcdefghijklmnopqrst");
    triggerResize(80);
    await advance(100);
    triggerResize(200);
    onTruncatedChange.mockClear();

    await advance(149);
    await paint();
    expect(onTruncatedChange).not.toHaveBeenCalled();
    expect(container.textContent).toBe("abc...qrst");

    await advance(1);
    expect(container.textContent).toBe("abc...qrst");
    await paint();
    expect(container.textContent).toBe("abcdefghijklmnopqrst");
    expect(onTruncatedChange).toHaveBeenCalledTimes(1);
    expect(onTruncatedChange).toHaveBeenLastCalledWith(false);
  });
});
