import { describe, expect, test } from "bun:test";
import {
  companyDomain,
  domainOf,
  isFreemail,
  isValidEmail,
  nameFromEmail,
  optionLabel,
  optionValue,
  orgNameFromDomain,
  storedOrgName,
  TEAM_SIZES,
  USE_CASE_GROUPS,
  USE_CASES,
} from "./company-profile";

describe("email domain helpers", () => {
  test("domainOf reads a lowercase domain, or null", () => {
    expect(domainOf(" Ada@Acme.COM ")).toBe("acme.com");
    expect(domainOf("ada@acme")).toBeNull();
    expect(domainOf("@acme.com")).toBeNull();
    expect(domainOf("ada")).toBeNull();
  });

  test("companyDomain skips free mail", () => {
    expect(companyDomain("ada@acme.com")).toBe("acme.com");
    expect(companyDomain("ada@gmail.com")).toBeNull();
    expect(companyDomain("ada@proton.me")).toBeNull();
  });

  test("isFreemail is true only for a known free-mail domain", () => {
    expect(isFreemail("ada@gmail.com")).toBe(true);
    expect(isFreemail("ada@outlook.com")).toBe(true);
    expect(isFreemail("ada@acme.com")).toBe(false);
    expect(isFreemail("not an email")).toBe(false);
  });

  test("isFreemail knows regional provider domains", () => {
    expect(isFreemail("ada@hotmail.es")).toBe(true);
    expect(isFreemail("ada@yahoo.co.uk")).toBe(true);
    expect(isFreemail("ada@web.de")).toBe(true);
    expect(isFreemail("ada@acme.co.uk")).toBe(false);
  });

  test("isValidEmail applies the API's email rule", () => {
    expect(isValidEmail("ada@acme.com")).toBe(true);
    expect(isValidEmail(" ada.lovelace+swarm@acme.co.uk ")).toBe(true);
    expect(isValidEmail("ada smith@acme.com")).toBe(false);
    expect(isValidEmail("ada@acme.io1")).toBe(false);
    expect(isValidEmail("ada@acme.c")).toBe(false);
    expect(isValidEmail("ada@acme")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });

  test("orgNameFromDomain names the company", () => {
    expect(orgNameFromDomain("acme.com")).toBe("Acme");
    expect(orgNameFromDomain("acme-labs.co.uk")).toBe("Acme Labs");
    expect(orgNameFromDomain("app.acme.io")).toBe("Acme");
  });

  test("nameFromEmail guesses a person's name", () => {
    expect(nameFromEmail("ada.lovelace@acme.com")).toBe("Ada Lovelace");
    expect(nameFromEmail("grace_hopper@acme.com")).toBe("Grace Hopper");
    expect(nameFromEmail("ada.lovelace+qa@acme.com")).toBe("Ada Lovelace");
    expect(nameFromEmail("qa+1024-2104-ui@desplega.ai")).toBe("Qa");
  });
});

describe("storedOrgName", () => {
  test("treats an empty name and the old default as unset", () => {
    expect(storedOrgName(" Acme ")).toBe("Acme");
    expect(storedOrgName("Swarm")).toBe("Swarm");
    expect(storedOrgName("Your Swarm")).toBeNull();
    expect(storedOrgName(" Your Swarm ")).toBeNull();
    expect(storedOrgName("  ")).toBeNull();
    expect(storedOrgName(undefined)).toBeNull();
  });
});

describe("option lists", () => {
  test("optionValue keeps a known value and drops anything else", () => {
    expect(optionValue(TEAM_SIZES, "2-10")).toBe("2-10");
    expect(optionValue(TEAM_SIZES, "1-5")).toBeNull();
    expect(optionValue(TEAM_SIZES, undefined)).toBeNull();
  });

  test("every use case sits in a group, and the groups keep the list order", () => {
    const groups = USE_CASE_GROUPS.map((group) => group.id);
    const order = USE_CASES.map((option) => groups.indexOf(option.group));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("optionLabel reads the label", () => {
    expect(optionLabel(USE_CASES, "features")).toBe("Ship features");
    expect(optionLabel(TEAM_SIZES, "1")).toBe("Just me");
    expect(optionLabel(USE_CASES, "nope")).toBeNull();
  });
});
