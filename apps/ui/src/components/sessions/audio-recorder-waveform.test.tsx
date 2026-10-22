import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React loads after the DOM, as in audio-recorder.test.tsx.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  await GlobalRegistrator.unregister();
});

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { TooltipProvider } = await import("../ui/tooltip");
const { RecordAudioButton, useAudioRecorder } = await import("./audio-recorder");

/** An analyser whose every frequency bin reads `level` (0 to 255). */
const fakeAnalyser = (level: number) => ({
  fftSize: 0,
  minDecibels: 0,
  frequencyBinCount: 128,
  getByteFrequencyData: (bins: Uint8Array) => bins.fill(level),
});

let closedContexts = 0;

class FakeAudioContext {
  createAnalyser = () => fakeAnalyser(0);
  createMediaStreamSource = () => ({ connect: () => {} });
  resume = async () => {};
  close = async () => {
    closedContexts++;
  };
}

class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

(globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
});

describe("recording waveform", () => {
  test("closes the AudioContext on stop and on unmount mid-recording", async () => {
    let recorder: ReturnType<typeof useAudioRecorder> | null = null;
    function Harness() {
      recorder = useAudioRecorder(() => {});
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await React.act(async () => root.render(<Harness />));

    await React.act(async () => recorder!.start());
    expect(recorder!.analyser).not.toBeNull();
    await React.act(async () => recorder!.stop());
    expect(recorder!.analyser).toBeNull();
    expect(closedContexts).toBe(1);

    await React.act(async () => recorder!.start());
    await React.act(async () => root.unmount());
    expect(closedContexts).toBe(2);
  });

  test("scales the bars from the analyser and leaves no frame behind on unmount", async () => {
    const pending = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
    globalThis.requestAnimationFrame = (callback) => {
      pending.set(++nextFrame, callback);
      return nextFrame;
    };
    globalThis.cancelAnimationFrame = (id) => void pending.delete(id);
    try {
      const container = document.createElement("div");
      const root = createRoot(container);
      const recorder = {
        status: "recording" as const,
        elapsedMs: 0,
        unavailableReason: null,
        analyser: fakeAnalyser(255) as unknown as AnalyserNode,
        start: async () => {},
        stop: () => {},
      };
      await React.act(async () =>
        root.render(
          <TooltipProvider>
            <RecordAudioButton recorder={recorder} />
          </TooltipProvider>,
        ),
      );

      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(0);
      const bars = [...container.querySelectorAll<HTMLElement>('span[aria-hidden="true"] > span')];
      expect(bars.map((bar) => bar.style.transform)).toEqual(Array(5).fill("scaleY(1)"));

      await React.act(async () => root.unmount());
      expect(pending.size).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = requestAnimationFrame;
      globalThis.cancelAnimationFrame = cancelAnimationFrame;
    }
  });
});
