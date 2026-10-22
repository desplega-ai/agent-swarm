import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import { INTEGRATIONS } from "./integrations-catalog";
import { deriveIntegrationStatus } from "./integrations-status";
import { resolveTranscriptionStatus } from "./transcription-status";

function row(key: string, value: string): SwarmConfig {
  return {
    id: `test-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "",
    lastUpdatedAt: "",
    encrypted: false,
    exportToEnv: true,
  };
}

describe("resolveTranscriptionStatus", () => {
  test("no key means off", () => {
    expect(resolveTranscriptionStatus([], {})).toBeNull();
  });

  test("each provider key alone is auto-detected", () => {
    for (const [keyEnv, provider] of [
      ["ELEVENLABS_API_KEY", "elevenlabs"],
      ["OPENAI_API_KEY", "openai"],
      ["GROQ_API_KEY", "groq"],
    ] as const) {
      expect(resolveTranscriptionStatus([], { [keyEnv]: true })).toEqual({
        provider,
        keyEnv,
        source: "auto",
      });
    }
  });

  test("ElevenLabs wins over OpenAI, OpenAI over Groq", () => {
    const all = { OPENAI_API_KEY: true, ELEVENLABS_API_KEY: true, GROQ_API_KEY: true };
    expect(resolveTranscriptionStatus([], all)?.provider).toBe("elevenlabs");
    expect(
      resolveTranscriptionStatus([], { OPENAI_API_KEY: true, GROQ_API_KEY: true })?.provider,
    ).toBe("openai");
  });

  test("an explicit key overrides detected keys", () => {
    const presence = {
      TRANSCRIPTION_API_KEY: true,
      OPENAI_API_KEY: true,
      ELEVENLABS_API_KEY: true,
    };
    expect(resolveTranscriptionStatus([], presence)).toEqual({
      provider: "openai",
      keyEnv: "TRANSCRIPTION_API_KEY",
      source: "explicit",
    });
    expect(
      resolveTranscriptionStatus([row("TRANSCRIPTION_PROVIDER", "groq")], presence)?.provider,
    ).toBe("groq");
  });

  test("a pinned provider uses only its own key", () => {
    const pinned = [row("TRANSCRIPTION_PROVIDER", "openai")];
    expect(
      resolveTranscriptionStatus(pinned, { ELEVENLABS_API_KEY: true, OPENAI_API_KEY: true }),
    ).toEqual({ provider: "openai", keyEnv: "OPENAI_API_KEY", source: "auto" });
    expect(resolveTranscriptionStatus(pinned, { ELEVENLABS_API_KEY: true })).toBeNull();
  });

  test("the integration card follows the same resolution", () => {
    const def = INTEGRATIONS.find((d) => d.id === "transcription")!;
    expect(deriveIntegrationStatus(def, [], {})).toBe("none");
    expect(deriveIntegrationStatus(def, [], { ELEVENLABS_API_KEY: true })).toBe("configured");
    expect(def.presenceKeys).toContain("GROQ_API_KEY");
  });
});
