import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as semver from "../../lib/semver";

let version: string | undefined;
let devMode: boolean | undefined;

// Root-run tests cannot resolve the `@/` alias that `use-feature-gate` imports.
mock.module("@/lib/semver", () => semver);
mock.module("./use-stats", () => ({
  useApiVersion: () => ({ data: version, isError: false, error: null }),
  useStats: () => ({ data: { devMode }, isError: false }),
}));

const { INVITES_MIN_VERSION, invitesSupportedBy, useInvitesSupport } = await import(
  "./use-invites-support"
);

beforeEach(() => {
  version = undefined;
  devMode = undefined;
});

describe("invitesSupportedBy", () => {
  test("the minimum is the first release after 2.6.0", () => {
    expect(INVITES_MIN_VERSION).toBe("2.6.1");
  });

  test("older and unknown versions hide the invite entry points", () => {
    for (const v of [null, undefined, "", "2.5.4", "2.6.0", "1.99.99"]) {
      expect(invitesSupportedBy(v)).toBe(false);
    }
  });

  test("the minimum and newer versions show them", () => {
    for (const v of ["2.6.1", "2.6.2", "2.7.0", "3.0.0", "2.6.1-beta.1"]) {
      expect(invitesSupportedBy(v)).toBe(true);
    }
  });
});

describe("useInvitesSupport", () => {
  test("follows the version check", () => {
    version = "2.6.0";
    expect(useInvitesSupport()).toBe(false);
    version = "2.6.1";
    expect(useInvitesSupport()).toBe(true);
  });

  test("is false while the version is unknown", () => {
    expect(useInvitesSupport()).toBe(false);
  });

  test("dev mode bypasses the version check", () => {
    version = "2.6.0";
    devMode = true;
    expect(useInvitesSupport()).toBe(true);
  });
});
