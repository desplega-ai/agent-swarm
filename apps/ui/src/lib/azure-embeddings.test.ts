import { describe, expect, test } from "bun:test";
import { azureBaseUrl, azurePathHint } from "./azure-embeddings";

describe("azureBaseUrl", () => {
  test("a resource name becomes the Foundry v1 URL", () => {
    expect(azureBaseUrl(" my-resource ")).toBe(
      "https://my-resource.services.ai.azure.com/openai/v1",
    );
  });

  test("any URL of the resource keeps its origin and gets /openai/v1", () => {
    for (const input of [
      "https://my-resource.services.ai.azure.com",
      "https://my-resource.services.ai.azure.com/",
      "https://my-resource.services.ai.azure.com/openai/v1",
      "https://my-resource.services.ai.azure.com/api/projects/demo",
      "my-resource.services.ai.azure.com",
    ]) {
      expect(azureBaseUrl(input)).toBe("https://my-resource.services.ai.azure.com/openai/v1");
    }
    expect(azureBaseUrl("https://legacy.openai.azure.com")).toBe(
      "https://legacy.openai.azure.com/openai/v1",
    );
  });

  test("empty stays empty", () => {
    expect(azureBaseUrl("  ")).toBe("");
  });
});

describe("azurePathHint", () => {
  test("names the missing path on every Azure host", () => {
    for (const host of [
      "my-resource.services.ai.azure.com",
      "my-resource.openai.azure.com",
      "my-resource.cognitiveservices.azure.com",
    ]) {
      expect(azurePathHint(`https://${host}`)).toBe(
        `Azure endpoints need the /openai/v1 path: https://${host}/openai/v1`,
      );
    }
  });

  test("no hint once the path is right, or off Azure", () => {
    expect(azurePathHint("https://my-resource.services.ai.azure.com/openai/v1")).toBeNull();
    expect(azurePathHint("https://my-resource.services.ai.azure.com/openai/v1/")).toBeNull();
    expect(azurePathHint("https://api.openai.com/v1")).toBeNull();
    expect(azurePathHint("https://azure.com.example.com/v1")).toBeNull();
    expect(azurePathHint("not a url")).toBeNull();
  });
});
