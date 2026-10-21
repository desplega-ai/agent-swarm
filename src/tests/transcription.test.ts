import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TranscriptionError, transcribeAudio } from "../utils/transcription";

const ENV_KEYS = [
  "TRANSCRIPTION_API_KEY",
  "TRANSCRIPTION_BASE_URL",
  "TRANSCRIPTION_MODEL",
  "TRANSCRIPTION_PROVIDER",
];
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
let reply: () => Response = () => Response.json({ text: " hello " });
let stt: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stt = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
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
        'TRANSCRIPTION_PROVIDER "deepgram" is not supported (use openai or elevenlabs)',
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
