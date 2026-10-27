import { describe, expect, test } from "bun:test";
import { inviteDestination } from "./invite-destination";

describe("inviteDestination", () => {
  test("compares origins rather than paths or trailing slashes", () => {
    expect(
      inviteDestination("https://app.example.com:443/path/", "https://app.example.com"),
    ).toEqual({ host: "app.example.com", differentOrigin: false });
  });

  test("detects a different host, scheme or port", () => {
    for (const appUrl of [
      "https://other.example.com",
      "http://app.example.com",
      "https://app.example.com:8443",
    ]) {
      expect(inviteDestination(appUrl, "https://app.example.com")?.differentOrigin).toBe(true);
    }
  });

  test("omits the destination for older APIs and invalid URLs", () => {
    expect(inviteDestination(undefined, "https://app.example.com")).toBeNull();
    expect(inviteDestination("invalid", "https://app.example.com")).toBeNull();
  });
});
