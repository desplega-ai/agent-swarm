/**
 * Speech-to-text through an OpenAI-compatible `/audio/transcriptions`
 * endpoint (OpenAI Whisper, Groq, a self-hosted whisper server). Off until
 * `TRANSCRIPTION_API_KEY` is set. `TRANSCRIPTION_BASE_URL` (default
 * `https://api.openai.com/v1`) and `TRANSCRIPTION_MODEL` (default
 * `whisper-1`) pick the service. Read at call time, so a config reload
 * applies without a restart.
 */
import { createValueScrubber, scrubSecrets } from "./secret-scrubber";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** The config key that switches transcription on. */
export const TRANSCRIPTION_API_KEY_ENV = "TRANSCRIPTION_API_KEY";

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env[TRANSCRIPTION_API_KEY_ENV]?.trim());
}

/** Transcribe one audio file. Throws `TranscriptionError` when unconfigured or when the call fails. */
export async function transcribeAudio(input: {
  data: Blob;
  filename: string;
  mimeType?: string;
}): Promise<string> {
  const apiKey = process.env[TRANSCRIPTION_API_KEY_ENV]?.trim();
  if (!apiKey) throw new TranscriptionError(`${TRANSCRIPTION_API_KEY_ENV} is not set`);
  const baseUrl = (process.env.TRANSCRIPTION_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  // scrubSecrets skips known values under 12 chars, and a self-hosted key can
  // be shorter, so the submitted key is scrubbed by value from every error.
  const keyScrubber = createValueScrubber([{ value: apiKey, name: TRANSCRIPTION_API_KEY_ENV }]);
  const scrub = (text: string) => scrubSecrets(keyScrubber.text(text));
  const form = new FormData();
  const type = input.mimeType ?? input.data.type;
  form.append("file", type ? new Blob([input.data], { type }) : input.data, input.filename);
  form.append("model", process.env.TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TranscriptionError(`no answer within ${TRANSCRIPTION_TIMEOUT_MS / 1000} s`);
    }
    throw new TranscriptionError(scrub(error instanceof Error ? error.message : String(error)));
  }
  const payload = (await response.json().catch(() => null)) as {
    text?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!response.ok || typeof payload?.text !== "string") {
    const detail =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : `HTTP ${response.status}`;
    throw new TranscriptionError(scrub(detail));
  }
  return payload.text.trim();
}
