import { describe, expect, test } from "bun:test";
import { generateEnv } from "../commands/onboard/env-generator.ts";
import { TEI_ARM64_IMAGE, teiImageForArch } from "../commands/onboard/tei-image.ts";
import { baselineState } from "./fixtures/onboard/baseline-states.ts";

describe("teiImageForArch", () => {
  test("arm64 and aarch64 get the arm64 TEI tag", () => {
    expect(TEI_ARM64_IMAGE).toBe("ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9.4");
    expect(teiImageForArch("arm64")).toBe(TEI_ARM64_IMAGE);
    expect(teiImageForArch("aarch64")).toBe(TEI_ARM64_IMAGE);
  });

  test("x64 and other arches keep the compose default", () => {
    expect(teiImageForArch("x64")).toBeNull();
    expect(teiImageForArch("ia32")).toBeNull();
    expect(teiImageForArch("")).toBeNull();
  });
});

describe("TEI_IMAGE in .env", () => {
  test("is written only with the arm64 tag", () => {
    const on = { ...baselineState("solo"), bundleAgentFs: true };
    const arm = generateEnv({ ...on, teiImage: teiImageForArch("arm64") });
    expect(arm).toContain(`\nTEI_IMAGE=${TEI_ARM64_IMAGE}\n`);
    expect(arm.match(/^TEI_IMAGE=/gm)).toHaveLength(1);

    const x64 = generateEnv({ ...on, teiImage: teiImageForArch("x64") });
    expect(x64).not.toContain("TEI_IMAGE");
    expect(x64).toContain("--no-agent-fs");
  });

  test("is never written with the bundle off", () => {
    const env = generateEnv({ ...baselineState("solo"), teiImage: TEI_ARM64_IMAGE });
    expect(env).not.toContain("TEI_IMAGE");
  });
});
