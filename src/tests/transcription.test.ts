import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  isTranscriptionConfigured,
  NOT_TRANSCRIBED_NOTE,
  resolveTranscriptionConfig,
  TRANSCRIPTION_ENV_KEYS,
  TranscriptionError,
  transcribeAudio,
  transcribeAudioNotes,
} from "../utils/transcription";

// Includes the provider keys the fallback reads: a worker shell often has
// OPENAI_API_KEY or ELEVENLABS_API_KEY set, which would leak into every test.
const ENV_KEYS = TRANSCRIPTION_ENV_KEYS;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type Captured = {
  path: string;
  authorization: string | null;
  xiApiKey: string | null;
  fields: string[];
  model: FormDataEntryValue | null;
  modelId: FormDataEntryValue | null;
  filename: string;
};

const captured: Captured[] = [];
// The file part's Content-Type as sent. Bun's `formData()` re-derives a File's
// type from its extension (`.webm` reads back as video/webm), so read it raw.
const sentFileTypes: string[] = [];
let reply: () => Response = () => Response.json({ text: " hello " });
let stt: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  stt = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.clone().text();
      sentFileTypes.push(
        /name="file"; filename="[^"]*"\r\nContent-Type: ([^\r\n]+)/.exec(raw)?.[1] ?? "",
      );
      const form = await req.formData();
      captured.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        xiApiKey: req.headers.get("xi-api-key"),
        fields: [...form.keys()].sort(),
        model: form.get("model"),
        modelId: form.get("model_id"),
        filename: (form.get("file") as File).name,
      });
      return reply();
    },
  });
});

afterAll(() => {
  stt.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  captured.length = 0;
  sentFileTypes.length = 0;
  reply = () => Response.json({ text: " hello " });
  for (const key of ENV_KEYS) delete process.env[key];
});

function configure(provider?: string) {
  process.env.TRANSCRIPTION_API_KEY = "stt-test-key-123456";
  process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${stt.port}/v1`;
  if (provider) process.env.TRANSCRIPTION_PROVIDER = provider;
}

const audio = {
  data: new Blob([new Uint8Array([1, 2, 3])]),
  filename: "note.ogg",
  mimeType: "audio/ogg",
};

describe("transcribeAudio request shape", () => {
  test("elevenlabs posts to /speech-to-text with xi-api-key and model_id", async () => {
    configure("elevenlabs");
    expect(await transcribeAudio(audio)).toBe("hello");
    expect(captured).toEqual([
      {
        path: "/v1/speech-to-text",
        authorization: null,
        xiApiKey: "stt-test-key-123456",
        fields: ["file", "model_id"],
        model: null,
        modelId: "scribe_v2",
        filename: "note.ogg",
      },
    ]);
  });

  test("elevenlabs honours TRANSCRIPTION_MODEL in model_id", async () => {
    configure("ElevenLabs");
    process.env.TRANSCRIPTION_MODEL = "scribe_v1";
    await transcribeAudio(audio);
    expect(captured[0]).toMatchObject({ fields: ["file", "model_id"], modelId: "scribe_v1" });
  });

  test("negative control: the default provider keeps the OpenAI shape", async () => {
    configure();
    expect(await transcribeAudio(audio)).toBe("hello");
    expect(captured).toEqual([
      {
        path: "/v1/audio/transcriptions",
        authorization: "Bearer stt-test-key-123456",
        xiApiKey: null,
        fields: ["file", "model"],
        model: "whisper-1",
        modelId: null,
        filename: "note.ogg",
      },
    ]);
  });

  test("an unknown provider fails before any request", async () => {
    configure("deepgram");
    await expect(transcribeAudio(audio)).rejects.toThrow(
      new TranscriptionError(
        'TRANSCRIPTION_PROVIDER "deepgram" is not supported (use openai, groq, elevenlabs)',
      ),
    );
    expect(captured).toHaveLength(0);
  });

  test("an elevenlabs error detail is surfaced with the key scrubbed", async () => {
    configure("elevenlabs");
    reply = () =>
      Response.json(
        { detail: { status: "invalid_api_key", message: "Invalid key stt-test-key-123456" } },
        { status: 401 },
      );
    await expect(transcribeAudio(audio)).rejects.toThrow(
      "Invalid key [REDACTED:TRANSCRIPTION_API_KEY]",
    );
  });
});

describe("provider key fallback", () => {
  // Built at runtime so the secret scanner does not read them as keys.
  const fake = (provider: string) => [provider, "fixture", "value"].join("-");
  const ELEVEN_FAKE = fake("eleven");
  const OPENAI_FAKE = fake("openai");
  const GROQ_FAKE = fake("groq");

  // Auto-detected keys always go to the provider's public endpoint, so record
  // that URL and forward the request to the local stub on the same path.
  const realFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  beforeEach(() => {
    calledUrls.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calledUrls.push(url.href);
      return realFetch(`http://127.0.0.1:${stt.port}${url.pathname}`, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("no key at all means not configured", async () => {
    expect(resolveTranscriptionConfig()).toBeNull();
    expect(isTranscriptionConfigured()).toBe(false);
    const notes = await transcribeAudioNotes([{ key: "a", name: "a.ogg", data: audio.data }], "t");
    expect(notes.get("a")).toBe(NOT_TRANSCRIBED_NOTE);
    expect(NOT_TRANSCRIBED_NOTE).toBe(
      "(not transcribed: no transcription provider configured, set TRANSCRIPTION_API_KEY or one of ELEVENLABS_API_KEY, OPENAI_API_KEY, GROQ_API_KEY)",
    );
    expect(calledUrls).toHaveLength(0);
  });

  test("ELEVENLABS_API_KEY alone uses the elevenlabs shape", async () => {
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    expect(resolveTranscriptionConfig()).toMatchObject({
      provider: "elevenlabs",
      keyEnv: "ELEVENLABS_API_KEY",
      source: "auto",
    });
    expect(await transcribeAudio(audio)).toBe("hello");
    expect(calledUrls).toEqual(["https://api.elevenlabs.io/v1/speech-to-text"]);
    expect(captured[0]).toMatchObject({
      xiApiKey: ELEVEN_FAKE,
      authorization: null,
      modelId: "scribe_v2",
    });
  });

  test("OPENAI_API_KEY alone uses the openai shape", async () => {
    process.env.OPENAI_API_KEY = OPENAI_FAKE;
    expect(resolveTranscriptionConfig()).toMatchObject({ provider: "openai", source: "auto" });
    await transcribeAudio(audio);
    expect(calledUrls).toEqual(["https://api.openai.com/v1/audio/transcriptions"]);
    expect(captured[0]).toMatchObject({
      authorization: `Bearer ${OPENAI_FAKE}`,
      model: "whisper-1",
    });
  });

  test("a pooled OPENAI_API_KEY sends one member", async () => {
    process.env.OPENAI_API_KEY = `${OPENAI_FAKE}-a,${OPENAI_FAKE}-b`;
    const apiKey = resolveTranscriptionConfig()?.apiKey;
    expect([`${OPENAI_FAKE}-a`, `${OPENAI_FAKE}-b`]).toContain(apiKey);
    await transcribeAudio(audio);
    expect(captured[0]?.authorization).toMatch(new RegExp(`^Bearer ${OPENAI_FAKE}-[ab]$`));
  });

  test("GROQ_API_KEY alone uses Groq's OpenAI-compatible endpoint and whisper model", async () => {
    process.env.GROQ_API_KEY = GROQ_FAKE;
    expect(resolveTranscriptionConfig()).toMatchObject({
      provider: "groq",
      keyEnv: "GROQ_API_KEY",
    });
    await transcribeAudio(audio);
    expect(calledUrls).toEqual(["https://api.groq.com/openai/v1/audio/transcriptions"]);
    expect(captured[0]).toMatchObject({
      authorization: `Bearer ${GROQ_FAKE}`,
      model: "whisper-large-v3-turbo",
    });
  });

  test("ElevenLabs wins over OpenAI and Groq when all are set", async () => {
    process.env.OPENAI_API_KEY = OPENAI_FAKE;
    process.env.GROQ_API_KEY = GROQ_FAKE;
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    await transcribeAudio(audio);
    expect(captured[0]).toMatchObject({ xiApiKey: ELEVEN_FAKE, authorization: null });
  });

  test("OpenAI wins over Groq", () => {
    process.env.GROQ_API_KEY = GROQ_FAKE;
    process.env.OPENAI_API_KEY = OPENAI_FAKE;
    expect(resolveTranscriptionConfig()?.provider).toBe("openai");
  });

  test("an explicit TRANSCRIPTION_API_KEY overrides both detected keys", async () => {
    process.env.OPENAI_API_KEY = OPENAI_FAKE;
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    configure();
    expect(resolveTranscriptionConfig()).toMatchObject({
      provider: "openai",
      keyEnv: "TRANSCRIPTION_API_KEY",
      source: "explicit",
    });
    await transcribeAudio(audio);
    // The explicit key honours TRANSCRIPTION_BASE_URL.
    expect(calledUrls).toEqual([`http://127.0.0.1:${stt.port}/v1/audio/transcriptions`]);
    expect(captured[0]).toMatchObject({
      authorization: "Bearer stt-test-key-123456",
      xiApiKey: null,
    });
  });

  test("an auto-detected key never goes to TRANSCRIPTION_BASE_URL", async () => {
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    process.env.TRANSCRIPTION_BASE_URL = "https://collector.example/v1";
    await transcribeAudio(audio);
    expect(calledUrls).toEqual(["https://api.elevenlabs.io/v1/speech-to-text"]);
  });

  test("a pinned provider uses only its own key", async () => {
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    process.env.OPENAI_API_KEY = OPENAI_FAKE;
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    await transcribeAudio(audio);
    expect(captured[0]).toMatchObject({ authorization: `Bearer ${OPENAI_FAKE}` });

    delete process.env.OPENAI_API_KEY;
    expect(isTranscriptionConfigured()).toBe(false);
  });

  test("a detected key is scrubbed from errors under its own name", async () => {
    process.env.ELEVENLABS_API_KEY = ELEVEN_FAKE;
    reply = () => Response.json({ detail: `bad key ${ELEVEN_FAKE}` }, { status: 401 });
    await expect(transcribeAudio(audio)).rejects.toThrow("bad key [REDACTED:ELEVENLABS_API_KEY]");
  });

  // The composer's mic button records webm in Chrome and Firefox; the upload
  // route drops `;codecs=` before it gets here. Each provider reads the format
  // from the file name, and all three list webm as supported.
  test.each([
    ["elevenlabs", "ELEVENLABS_API_KEY", "https://api.elevenlabs.io/v1/speech-to-text"],
    ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1/audio/transcriptions"],
    ["groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1/audio/transcriptions"],
  ])("a recorded webm clip reaches %s as a .webm audio/webm file", async (name, keyEnv, url) => {
    process.env[keyEnv] = fake(name);
    const clip = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm" });
    const notes = await transcribeAudioNotes(
      [{ key: "c", name: "recording-2026-10-21-143005.webm", data: clip, mimeType: "audio/webm" }],
      "t",
    );
    expect(notes.get("c")).toBe("[Transcript of recording-2026-10-21-143005.webm]\nhello");
    expect(calledUrls).toEqual([url]);
    expect(captured[0]).toMatchObject({ filename: "recording-2026-10-21-143005.webm" });
    expect(sentFileTypes).toEqual(["audio/webm"]);
  });
});
