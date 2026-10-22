/**
 * In-browser voice notes for the composer. The mic button records with
 * `getUserMedia` + `MediaRecorder`; stop hands the clip to the composer as an
 * ordinary attachment, so it goes through the same upload as a picked file and
 * the server appends its `[Transcript of <file>]` block to the draft task.
 *
 * The state lives in `useAudioRecorder`, held by the composer, not in the
 * button: the composer swaps its steer and follow-up children under a poll,
 * and a recording owned by the outgoing child would die with its unmount.
 */

import { Mic, MicOff, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The containers to ask MediaRecorder for, best first. Chrome and Firefox
 * record webm/opus, Safari mp4/AAC. Every transcription provider accepts both.
 */
const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

/** The file extension per container. `audio/mp4` is an audio-only mp4: `.m4a`. */
const RECORDING_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

const ELAPSED_TICK_MS = 250;
const MIC_BLOCKED = "Microphone access is blocked";

function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** `recording-2026-10-21-143005.webm`, from the recorder's container type. */
export function recordingFileName(mimeType: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `recording-${stamp}.${RECORDING_EXTENSIONS[mimeType] ?? "webm"}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface AudioRecorder {
  status: "idle" | "starting" | "recording";
  elapsedMs: number;
  /** Why recording is off (no MediaRecorder, mic blocked, no mic), or null. */
  unavailableReason: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

/** Records one clip at a time; `onClip` receives it as a `File` on stop. */
export function useAudioRecorder(onClip: (file: File) => void): AudioRecorder {
  const [status, setStatus] = useState<AudioRecorder["status"]>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(() =>
    isRecordingSupported() ? null : "This browser cannot record audio",
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(false);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  // A mic the user already blocked disables the button before the first click.
  useEffect(() => {
    if (!isRecordingSupported() || !navigator.permissions?.query) return;
    let permission: PermissionStatus | null = null;
    let cancelled = false;
    const apply = () => {
      if (permission?.state === "denied") setUnavailableReason(MIC_BLOCKED);
      else setUnavailableReason((current) => (current === MIC_BLOCKED ? null : current));
    };
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((result) => {
        if (cancelled) return;
        permission = result;
        apply();
        result.addEventListener("change", apply);
      })
      // Firefox and older Safari do not know the "microphone" permission name.
      .catch(() => {});
    return () => {
      cancelled = true;
      permission?.removeEventListener("change", apply);
    };
  }, []);

  // Unmount mid-recording drops the clip and frees the mic. Set on every mount:
  // StrictMode runs this cleanup once before the real mount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder) recorder.onstop = null;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      release();
    };
  }, [release]);

  const start = useCallback(async () => {
    if (recorderRef.current || unavailableReason) return;
    setStatus("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setUnavailableReason(MIC_BLOCKED);
      } else if (name === "NotFoundError") {
        setUnavailableReason("No microphone found");
      } else {
        toast.error(`Could not start recording: ${error instanceof Error ? error.message : error}`);
      }
      setStatus("idle");
      return;
    }
    const stopTracks = () => {
      for (const track of stream.getTracks()) track.stop();
    };
    // Unmounted while the permission prompt was up: free the mic, record nothing.
    if (!mountedRef.current) return stopTracks();
    const requested = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, requested ? { mimeType: requested } : undefined);
    } catch (error) {
      stopTracks();
      setStatus("idle");
      toast.error(`Could not start recording: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      // The server reads the container from the content type: drop `;codecs=`.
      const mimeType = (recorder.mimeType || requested || "audio/webm").split(";")[0]!.trim();
      release();
      setStatus("idle");
      setElapsedMs(0);
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        toast.error("The recording was empty.");
        return;
      }
      onClipRef.current(new File([blob], recordingFileName(mimeType), { type: mimeType }));
    };
    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    const startedAt = Date.now();
    setElapsedMs(0);
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), ELAPSED_TICK_MS);
    setStatus("recording");
  }, [release, unavailableReason]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  return { status, elapsedMs, unavailableReason, start, stop };
}

/** The composer's mic button: record, then stop with the elapsed time shown. */
export function RecordAudioButton({
  recorder,
  disabled,
  bar,
}: {
  recorder: AudioRecorder;
  disabled?: boolean;
  /** 44 px touch target, as the dock's other bar-mode buttons. */
  bar?: boolean;
}) {
  const { status, elapsedMs, unavailableReason } = recorder;
  if (status === "recording") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Stop recording"
            onClick={recorder.stop}
            className={cn(
              "rounded-full gap-1.5 px-2.5 text-status-error-strong hover:text-status-error-strong",
              bar ? "h-11" : "h-8",
            )}
          >
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current animate-pulse" />
            <span className="font-mono text-xs tabular-nums" aria-live="off">
              {formatElapsed(elapsedMs)}
            </span>
            <Square className="h-3.5 w-3.5 fill-current" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Stop and attach the recording</TooltipContent>
      </Tooltip>
    );
  }
  const off = unavailableReason !== null;
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
      <TooltipTrigger asChild>
        <span tabIndex={off ? 0 : -1} className="inline-flex">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={off || disabled || status === "starting"}
            aria-label={off ? `Record audio (${unavailableReason})` : "Record audio"}
            onClick={() => void recorder.start()}
            className={cn(
              "rounded-full text-muted-foreground hover:text-foreground",
              bar ? "size-11" : "h-8 w-8",
            )}
          >
            {off ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{off ? unavailableReason : "Record audio"}</TooltipContent>
    </Tooltip>
  );
}
