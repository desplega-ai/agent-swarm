/**
 * Speech-to-text for inbound audio. Off until `TRANSCRIPTION_API_KEY` is set.
 * `TRANSCRIPTION_PROVIDER` picks the request shape:
 *
 * - `openai` (default): `POST <base>/audio/transcriptions`, `Authorization:
 *   Bearer`, form field `model`. OpenAI Whisper, Groq, and self-hosted whisper
 *   servers speak this shape.
 * - `elevenlabs`: `POST <base>/speech-to-text`, `xi-api-key` header, form
 *   field `model_id`.
 *
 * `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL` override the provider's
 * defaults. Deepgram and AssemblyAI use other request shapes and are not
 * supported. Read at call time, so a config reload applies without a restart.
 */
import { createValueScrubber, scrubSecrets } from "./secret-scrubber";

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** The config key that switches transcription on. */
export const TRANSCRIPTION_API_KEY_ENV = "TRANSCRIPTION_API_KEY";

type ProviderSpec = {
  defaultBaseUrl: string;
  defaultModel: string;
  path: string;
  modelField: string;
  authHeaders: (apiKey: string) => Record<string, string>;
};

const PROVIDERS = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    path: "/audio/transcriptions",
    modelField: "model",
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  elevenlabs: {
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    defaultModel: "scribe_v2",
    path: "/speech-to-text",
    modelField: "model_id",
    authHeaders: (apiKey) => ({ "xi-api-key": apiKey }),
  },
} satisfies Record<string, ProviderSpec>;

type TranscriptionProvider = keyof typeof PROVIDERS;

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env[TRANSCRIPTION_API_KEY_ENV]?.trim());
}

function resolveProvider(): ProviderSpec {
  const name = process.env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase() || "openai";
  if (!Object.hasOwn(PROVIDERS, name)) {
    throw new TranscriptionError(
      `TRANSCRIPTION_PROVIDER "${name}" is not supported (use ${Object.keys(PROVIDERS).join(" or ")})`,
    );
  }
  return PROVIDERS[name as TranscriptionProvider];
}

/** OpenAI puts the reason in `error.message`; ElevenLabs in `detail.message` or `detail`. */
function errorDetail(payload: Record<string, unknown> | null, status: number): string {
  const error = payload?.error as { message?: unknown } | undefined;
  if (typeof error?.message === "string") return error.message;
  const detail = payload?.detail as { message?: unknown } | string | undefined;
  if (typeof detail === "string") return detail;
  if (typeof detail?.message === "string") return detail.message;
  return `HTTP ${status}`;
}

/** Transcribe one audio file. Throws `TranscriptionError` when unconfigured or when the call fails. */
export async function transcribeAudio(input: {
  data: Blob;
  filename: string;
  mimeType?: string;
}): Promise<string> {
  const apiKey = process.env[TRANSCRIPTION_API_KEY_ENV]?.trim();
  if (!apiKey) throw new TranscriptionError(`${TRANSCRIPTION_API_KEY_ENV} is not set`);
  const provider = resolveProvider();
  const baseUrl = (process.env.TRANSCRIPTION_BASE_URL?.trim() || provider.defaultBaseUrl).replace(
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
  form.append(
    provider.modelField,
    process.env.TRANSCRIPTION_MODEL?.trim() || provider.defaultModel,
  );

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${provider.path}`, {
      method: "POST",
      headers: provider.authHeaders(apiKey),
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TranscriptionError(`no answer within ${TRANSCRIPTION_TIMEOUT_MS / 1000} s`);
    }
    throw new TranscriptionError(scrub(error instanceof Error ? error.message : String(error)));
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof payload?.text !== "string") {
    throw new TranscriptionError(scrub(errorDetail(payload, response.status)));
  }
  return payload.text.trim();
}
