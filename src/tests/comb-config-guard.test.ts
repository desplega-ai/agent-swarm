import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";

describe("Comb config keys", () => {
  test("COMB_ENABLED accepts boolean literals only", () => {
    for (const value of ["true", "false", "1", "0", " TRUE "]) {
      expect(validateConfigValue("COMB_ENABLED", value)).toBeNull();
    }
    for (const value of ["yes", "on", ""]) {
      expect(validateConfigValue("COMB_ENABLED", value)).toContain("Invalid COMB_ENABLED");
    }
  });

  test("AGENT_FS_PUBLIC_URL accepts blank or an http(s) base URL", () => {
    for (const value of ["", "http://localhost:7433", "https://agent-fs.example.com/base"]) {
      expect(validateConfigValue("AGENT_FS_PUBLIC_URL", value)).toBeNull();
    }
    for (const value of [
      "agent-fs.example.com",
      "not a url",
      "ftp://agent-fs.example.com",
      "https://agent-fs.example.com/?x=1",
      "https://agent-fs.example.com/#frag",
    ]) {
      expect(validateConfigValue("AGENT_FS_PUBLIC_URL", value)).toContain(
        "Invalid AGENT_FS_PUBLIC_URL",
      );
    }
  });

  test("OPENROUTER_BASE_URL keeps its rules after sharing the URL validator", () => {
    expect(validateConfigValue("OPENROUTER_BASE_URL", "")).toBeNull();
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://api.example.com/v1")).toBeNull();
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://api.example.com/v1?x=1")).toContain(
      "Invalid OPENROUTER_BASE_URL",
    );
  });
});
