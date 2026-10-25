import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
import { buildContext } from "../telemetry-context";
import {
  COMPANY_ACQUISITION_SOURCES,
  COMPANY_TEAM_SIZES,
  COMPANY_USE_CASES,
  reportedUseCase,
  reportedUserFunction,
} from "../utils/company-profile";
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

  test("never suggests a regional or single-domain free-mail provider", () => {
    for (const domain of [
      "hotmail.es",
      "yahoo.co.uk",
      "outlook.fr",
      "web.de",
      "gmx.net",
      "pm.me",
      "mail.ru",
      "live.co.uk",
      "live.nl",
      "yandex.com.tr",
      "yandex.kz",
      "icloud.com",
      "me.com",
      "proton.me",
      "protonmail.ch",
      "aol.de",
      "qq.com",
      "163.com",
      "naver.com",
      "Hotmail.CO.UK",
      "mail.yahoo.com",
    ]) {
      expect(websiteSuggestion(domain)).toBeNull();
    }
  });

  test("keeps company domains that only look like a provider", () => {
    for (const domain of [
      "acme.co.uk",
      "acme.com.br",
      "mailchimp.com",
      "live.acme.com",
      "yahoo-labs.dev",
      "proton.ai",
      "web.dev",
    ]) {
      expect(websiteSuggestion(domain)).toBe(domain);
    }
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

describe("company profile config guards", () => {
  for (const [key, values] of [
    ["SWARM_ORG_TEAM_SIZE", COMPANY_TEAM_SIZES],
    ["SWARM_ORG_USE_CASE", COMPANY_USE_CASES],
    ["SWARM_ORG_ACQUISITION_SOURCE", COMPANY_ACQUISITION_SOURCES],
  ] as const) {
    test(`${key} accepts its enum or empty, and rejects other values`, () => {
      for (const value of ["", ...values]) expect(validateConfigValue(key, value)).toBeNull();
      for (const value of ["unknown", "OTHER", "free text", null, 1, true]) {
        expect(validateConfigValue(key, value)).toContain(key);
      }
    });
  }
});

describe("profile values the telemetry catalog does not list yet", () => {
  const input = {
    orgId: "org_0123456789abcdef",
    installationId: "install_0123456789abcdef",
    isCloud: false,
    isE2b: false,
    swarmVersion: "1.0.0",
    actor: { userId: "user-1" },
  };

  test("the config guards accept them", () => {
    for (const value of ["content", "research", "seo", "admin"]) {
      expect(validateConfigValue("SWARM_ORG_USE_CASE", value)).toBeNull();
    }
  });

  test("stay out of the telemetry context, as if unset", () => {
    for (const useCase of ["content", "research", "seo", "admin"]) {
      expect(reportedUseCase(useCase)).toBeUndefined();
      expect(buildContext({ ...input, useCase })).not.toHaveProperty("use_case");
    }
    for (const userFunction of ["marketing", "sales", "research"]) {
      expect(reportedUserFunction(userFunction)).toBeUndefined();
      expect(buildContext({ ...input, userFunction })).not.toHaveProperty("user_function");
    }
  });

  test("the catalog values still report", () => {
    const context = buildContext({ ...input, useCase: "docs", userFunction: "founder" });
    expect(context.use_case).toBe("docs");
    expect(context.user_function).toBe("founder");
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
