import { expect, test } from "bun:test";
import { shortId } from "./short-id";

test("shortId: a UUID or hex id to 8 characters, a slug as is", () => {
  expect(shortId("8dcee854-1f0a-4c55-9a43-2b3c7e9d0f11")).toBe("8dcee854");
  expect(shortId("cfd9bc4bc838487ea7cde4708dfb4dc1")).toBe("cfd9bc4b");
  expect(shortId("helmcode-benchmark")).toBe("helmcode-benchmark");
});
