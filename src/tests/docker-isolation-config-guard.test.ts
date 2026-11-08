import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";

describe("Docker isolation config validation", () => {
  test("DOCKER_HARDENED accepts boolean literals only", () => {
    for (const value of ["true", "false", "1", "0", "TRUE"]) {
      expect(validateConfigValue("DOCKER_HARDENED", value)).toBeNull();
    }
    expect(validateConfigValue("DOCKER_HARDENED", "yes")).toMatch(/DOCKER_HARDENED/);
  });

  test("DOCKER_RUNTIME accepts an OCI runtime name or empty", () => {
    for (const value of ["runsc", "kata", "io.containerd.kata.v2", "runc_2", "", "  runsc  "]) {
      expect(validateConfigValue("DOCKER_RUNTIME", value)).toBeNull();
    }
    for (const value of ["run sc", "../runsc", "runsc;rm", "/usr/bin/runsc"]) {
      expect(validateConfigValue("DOCKER_RUNTIME", value)).toMatch(/DOCKER_RUNTIME/);
    }
  });

  test("DOCKER_PIDS_LIMIT accepts a positive integer or empty", () => {
    for (const value of ["1", "256", "4096", "", " 512 "]) {
      expect(validateConfigValue("DOCKER_PIDS_LIMIT", value)).toBeNull();
    }
    for (const value of ["0", "-5", "12abc", "1.5", "99999999999999999999", "lots"]) {
      expect(validateConfigValue("DOCKER_PIDS_LIMIT", value)).toMatch(/DOCKER_PIDS_LIMIT/);
    }
  });
});
