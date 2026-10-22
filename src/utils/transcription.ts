/**
 * Speech-to-text for inbound audio. `TRANSCRIPTION_PROVIDER` picks the request
 * shape:
 *
 * - `openai`: `POST <base>/audio/transcriptions`, `Authorization: Bearer`, form
 *   field `model`. OpenAI Whisper and self-hosted whisper servers speak this
 *   shape.
 * - `groq`: the `openai` shape against Groq's OpenAI-compatible endpoint.
 * - `elevenlabs`: `POST <base>/speech-to-text`, `xi-api-key` header, form
 *   field `model_id`.
 *
 * The key: an explicit `TRANSCRIPTION_API_KEY` wins, with `TRANSCRIPTION_PROVIDER`
 * (default `openai`). Without it, transcription reuses a provider key the
 * swarm already has: the pinned provider's key when `TRANSCRIPTION_PROVIDER` is
 * set, else the first of `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`.
 * Off when none is set.
 *
 * `TRANSCRIPTION_MODEL` overrides the provider's default model.
 * `TRANSCRIPTION_BASE_URL` overrides its base URL for an explicit key only: an
 * auto-detected key always goes to its provider's own endpoint. Deepgram and AssemblyAI use other request shapes and are not
 * supported. Read at call time, so a config reload applies without a restart.
 */
import { createValueScrubber, scrubSecrets } from "./secret-scrubber";

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** The config key that switches transcription on explicitly. */
export const TRANSCRIPTION_API_KEY_ENV = "TRANSCRIPTION_API_KEY";

type ProviderSpec = {
  /** The provider's own key, reused when `TRANSCRIPTION_API_KEY` is unset. */
  keyEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  path: string;
  modelField: string;
  authHeaders: (apiKey: string) => Record<string, string>;
};

const openAIShape = {
  path: "/audio/transcriptions",
  modelField: "model",
  authHeaders: (apiKey: string) => ({ authorization: `Bearer ${apiKey}` }),
};

const PROVIDERS = {
  openai: {
    keyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    ...openAIShape,
  },
  groq: {
    keyEnv: "GROQ_API_KEY",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
    ...openAIShape,
  },
  elevenlabs: {
    keyEnv: "ELEVENLABS_API_KEY",
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    defaultModel: "scribe_v2",
    path: "/speech-to-text",
    modelField: "model_id",
    authHeaders: (apiKey) => ({ "xi-api-key": apiKey }),
  },
} satisfies Record<string, ProviderSpec>;

export type TranscriptionProvider = keyof typeof PROVIDERS;

/** Order in which an existing provider key is picked when nothing is pinned. */
const AUTO_DETECT_ORDER: TranscriptionProvider[] = ["elevenlabs", "openai", "groq"];

/** Every env key the provider and key resolution reads. */
export const TRANSCRIPTION_ENV_KEYS = [
  TRANSCRIPTION_API_KEY_ENV,
  "TRANSCRIPTION_PROVIDER",
  "TRANSCRIPTION_BASE_URL",
  "TRANSCRIPTION_MODEL",
  ...AUTO_DETECT_ORDER.map((name) => PROVIDERS[name].keyEnv),
];

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/** The provider and key a transcription call uses. */
export type TranscriptionConfig = {
  provider: string;
  apiKey: string;
  /** The env key the API key came from. */
  keyEnv: string;
  /** `explicit`: `TRANSCRIPTION_API_KEY`. `auto`: a provider key the swarm already had. */
  source: "explicit" | "auto";
};

function envValue(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

/** Resolve provider and key, or null when no key is set. Unsupported provider names pass through. */
export function resolveTranscriptionConfig(): TranscriptionConfig | null {
  const pinned = envValue("TRANSCRIPTION_PROVIDER")?.toLowerCase();
  const explicitKey = envValue(TRANSCRIPTION_API_KEY_ENV);
  if (explicitKey) {
    return {
      provider: pinned ?? "openai",
      apiKey: explicitKey,
      keyEnv: TRANSCRIPTION_API_KEY_ENV,
      source: "explicit",
    };
  }
  // A pinned provider only uses its own key, never another provider's.
  const candidates = pinned
    ? AUTO_DETECT_ORDER.filter((name) => name === pinned)
    : AUTO_DETECT_ORDER;
  for (const name of candidates) {
    const { keyEnv } = PROVIDERS[name];
    const apiKey = envValue(keyEnv);
    if (apiKey) return { provider: name, apiKey, keyEnv, source: "auto" };
  }
  return null;
}

export function isTranscriptionConfigured(): boolean {
  return resolveTranscriptionConfig() !== null;
}

function providerSpec(name: string): ProviderSpec {
  if (!Object.hasOwn(PROVIDERS, name)) {
    throw new TranscriptionError(
      `TRANSCRIPTION_PROVIDER "${name}" is not supported (use ${Object.keys(PROVIDERS).join(", ")})`,
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
  const config = resolveTranscriptionConfig();
  if (!config) throw new TranscriptionError("no transcription provider key is set");
  const { apiKey } = config;
  const provider = providerSpec(config.provider);
  // An auto-detected key only goes to its own provider: a base URL set in
  // config must not receive a key that was stored for another purpose.
  const baseUrlOverride =
    config.source === "explicit" ? process.env.TRANSCRIPTION_BASE_URL?.trim() : undefined;
  const baseUrl = (baseUrlOverride || provider.defaultBaseUrl).replace(/\/+$/, "");
  // scrubSecrets skips known values under 12 chars, and a self-hosted key can
  // be shorter, so the submitted key is scrubbed by value from every error.
  const keyScrubber = createValueScrubber([{ value: apiKey, name: config.keyEnv }]);
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

/** The task-text note for an audio file when no provider is configured. */
export const NOT_TRANSCRIBED_NOTE = `(not transcribed: no transcription provider configured, set ${TRANSCRIPTION_API_KEY_ENV} or one of ${AUTO_DETECT_ORDER.map((name) => PROVIDERS[name].keyEnv).join(", ")})`;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

/** One audio file to transcribe. `key` names its note in the returned map. */
export type AudioFile = { key: string; name: string; data: Blob; mimeType?: string };

/**
 * Transcribe audio files into task-text notes, one per file: `[Transcript of
 * <name>]` and the text, `(transcription failed: <reason>)`, or (when no
 * provider is configured) `NOT_TRANSCRIBED_NOTE`. Never throws, so a failed
 * call never blocks the task it belongs to. `logPrefix` tags the warning.
 */
export async function transcribeAudioNotes(
  files: AudioFile[],
  logPrefix: string,
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (files.length === 0) return notes;
  if (!isTranscriptionConfigured()) {
    for (const file of files) notes.set(file.key, NOT_TRANSCRIBED_NOTE);
    return notes;
  }
  for (const file of files) {
    // Voice notes can carry no file name; the endpoint reads the format from the extension.
    const extension = AUDIO_EXTENSIONS[file.mimeType ?? ""] ?? "ogg";
    const filename = /\.\w+$/.test(file.name) ? file.name : `${file.name}.${extension}`;
    try {
      const text = await transcribeAudio({ data: file.data, filename, mimeType: file.mimeType });
      notes.set(file.key, `[Transcript of ${file.name}]\n${text || "(no speech recognized)"}`);
    } catch (error) {
      const reason = scrubSecrets(error instanceof Error ? error.message : String(error));
      console.warn(`${logPrefix} could not transcribe file ${file.key}: ${reason}`);
      notes.set(file.key, `(transcription failed: ${reason})`);
    }
  }
  return notes;
}
