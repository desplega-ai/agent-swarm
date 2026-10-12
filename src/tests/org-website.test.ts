import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
import { buildContext } from "../telemetry-context";
import {
  isFilledOrgLogoUrl,
  normalizeOrgWebsite,
  orgLogoUrl,
  websiteSuggestion,
} from "../utils/org-website";

describe("normalizeOrgWebsite", () => {
  const accepted: Array<[string, string]> = [
    ["acme.com", "acme.com"],
    ["Acme.COM", "acme.com"],
    ["www.acme.com", "acme.com"],
    ["https://www.acme.com/about?x=1#y", "acme.com"],
    ["http://acme.co.uk:8080/", "acme.co.uk"],
    ["  shop.acme.io.  ", "shop.acme.io"],
    ["acme.com.", "acme.com"],
  ];
  for (const [input, expected] of accepted) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(normalizeOrgWebsite(input)).toBe(expected);
    });
  }

  const rejected = [
    "",
    "   ",
    "localhost",
    "http://localhost:3000",
    "intranet",
    "10.0.0.1",
    "http://[::1]/",
    "printer.local",
    "api.internal",
    "ftp://acme.com",
    "https://user:pass@acme.com",
    "acme..com",
    "-acme.com",
    "acme.123",
    `${"a".repeat(250)}.com`,
  ];
  for (const input of rejected) {
    test(`rejects ${JSON.stringify(input.slice(0, 40))}`, () => {
      expect(normalizeOrgWebsite(input)).toBeNull();
    });
  }
});

describe("org logo URL", () => {
  test("points at the proxy logo endpoint and is recognised as filled", () => {
    const url = orgLogoUrl("acme.com");
    expect(url).toBe("https://proxy.desplega.sh/v1/logo?domain=acme.com");
    expect(isFilledOrgLogoUrl(url)).toBe(true);
  });

  test("a logo a person set is not a filled one", () => {
    expect(isFilledOrgLogoUrl("https://acme.com/logo.svg")).toBe(false);
    expect(isFilledOrgLogoUrl("")).toBe(false);
    expect(isFilledOrgLogoUrl("not a url")).toBe(false);
  });

  test("the logo path on another origin is not a filled one", () => {
    expect(isFilledOrgLogoUrl("https://brand.acme.com/v1/logo?domain=acme.com")).toBe(false);
    expect(isFilledOrgLogoUrl("http://stub.test/v1/logo?domain=acme.com", "http://stub.test")).toBe(
      true,
    );
  });
});

describe("websiteSuggestion", () => {
  test("suggests a company email domain and never a free-mail one", () => {
    expect(websiteSuggestion("acme.com")).toBe("acme.com");
    expect(websiteSuggestion("gmail.com")).toBeNull();
    expect(websiteSuggestion(null)).toBeNull();
  });
});

describe("SWARM_ORG_WEBSITE config guard", () => {
  test("accepts a bare hostname, or empty to clear it", () => {
    expect(validateConfigValue("SWARM_ORG_WEBSITE", "acme.com")).toBeNull();
    expect(validateConfigValue("SWARM_ORG_WEBSITE", "")).toBeNull();
  });

  test("rejects anything that is not already a bare public hostname", () => {
    for (const value of ["https://acme.com", "www.acme.com", "localhost", "10.0.0.1"]) {
      expect(validateConfigValue("SWARM_ORG_WEBSITE", value)).toContain("SWARM_ORG_WEBSITE");
    }
  });

  test("SWARM_USED_BY_CONSENT is a boolean", () => {
    expect(validateConfigValue("SWARM_USED_BY_CONSENT", "true")).toBeNull();
    expect(validateConfigValue("SWARM_USED_BY_CONSENT", "maybe")).not.toBeNull();
  });
});

describe("org_website in the telemetry context", () => {
  const input = {
    orgId: "org_0123456789abcdef",
    installationId: "install_0123456789abcdef",
    isCloud: false,
    isE2b: false,
    swarmVersion: "1.0.0",
  };

  test("is present when set", () => {
    expect(buildContext({ ...input, orgWebsite: "acme.com" }).org_website).toBe("acme.com");
  });

  test("is left out, not null, when unset or invalid", () => {
    expect(buildContext(input)).not.toHaveProperty("org_website");
    expect(buildContext({ ...input, orgWebsite: "not a host" })).not.toHaveProperty("org_website");
  });
});
