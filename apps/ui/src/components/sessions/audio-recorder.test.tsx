import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React loads after the DOM: StrictMode's mount-time effect replay, which
// this file tests, does not run when React loads first.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  await GlobalRegistrator.unregister();
});

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAudioRecorder } = await import("./audio-recorder");

let stoppedTracks = 0;

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
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stoppedTracks++ }] }),
  },
});

describe("useAudioRecorder", () => {
  test("records under StrictMode, whose extra effect cleanup runs on mount", async () => {
    const clips: File[] = [];
    let recorder: ReturnType<typeof useAudioRecorder> | null = null;
    function Harness() {
      recorder = useAudioRecorder((clip) => clips.push(clip));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await React.act(async () =>
      root.render(
        <React.StrictMode>
          <Harness />
        </React.StrictMode>,
      ),
    );

    await React.act(async () => recorder!.start());
    expect(recorder!.status).toBe("recording");
    await React.act(async () => recorder!.stop());

    expect(recorder!.status).toBe("idle");
    expect(clips.map((clip) => clip.type)).toEqual(["audio/webm"]);
    expect(stoppedTracks).toBe(1);
    await React.act(async () => root.unmount());
  });
});
