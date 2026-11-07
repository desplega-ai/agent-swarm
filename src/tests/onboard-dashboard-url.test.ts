import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOnboardDashboardUrl,
  maskDashboardUrlApiKey,
  SETUP_URL_PATH,
  writeDashboardSetupUrl,
} from "../commands/onboard/dashboard-url.ts";

describe("dashboard URL masking", () => {
  test.each([
    "short",
    "a".repeat(32),
    "fixture with +/=&?# characters",
  ])("masks the entire key, including URL-encoded characters: %s", (apiKey) => {
    const url = buildOnboardDashboardUrl({
      apiUrl: "https://swarm.example.com",
      apiKey,
      name: "My swarm",
    });
    const masked = maskDashboardUrlApiKey(url);
    expect(masked).toContain("apiKey=[REDACTED:apiKey]");
    expect(masked).not.toContain(encodeURIComponent(apiKey));
    expect(masked).toContain("&name=My+swarm");
    // The private link still auto-connects with the original key.
    expect(new URL(url).searchParams.get("apiKey")).toBe(apiKey);
  });

  test("covers repeated parameters and preserves fragments", () => {
    expect(maskDashboardUrlApiKey("https://example.com?apiKey=one&apiKey=two#section")).toBe(
      "https://example.com?apiKey=[REDACTED:apiKey]&apiKey=[REDACTED:apiKey]#section",
    );
  });

  test("leaves a link without a key unchanged", () => {
    const url = buildOnboardDashboardUrl({ apiUrl: "https://swarm.example.com" });
    expect(maskDashboardUrlApiKey(url)).toBe(url);
  });
});

describe("private setup link", () => {
  let dir: string;
  const url = buildOnboardDashboardUrl({ apiUrl: "https://swarm.example.com", apiKey: "fixture" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onboard-setup-url-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saves the complete URL with mode 600", async () => {
    await writeDashboardSetupUrl(dir, url);
    const path = join(dir, SETUP_URL_PATH);
    expect(await Bun.file(path).text()).toBe(`${url}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("replaces a permissive file with a private file", async () => {
    const path = join(dir, SETUP_URL_PATH);
    await Bun.write(path, "old link");
    await chmod(path, 0o644);
    await writeDashboardSetupUrl(dir, url);
    expect(await Bun.file(path).text()).toBe(`${url}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("replaces a symlink without overwriting its target", async () => {
    const path = join(dir, SETUP_URL_PATH);
    const target = join(dir, "other-file");
    await Bun.write(path, "old link");
    await Bun.file(path).delete();
    await Bun.write(target, "keep this content");
    await symlink(target, path);
    await writeDashboardSetupUrl(dir, url);
    expect(await Bun.file(target).text()).toBe("keep this content");
    expect(await Bun.file(path).text()).toBe(`${url}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
