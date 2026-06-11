import { describe, expect, test } from "bun:test";
import { cleanVersion, stripAnsi } from "./version.ts";

const ESC = "\u001b";
const BEL = "\u0007";

describe("stripAnsi", () => {
  test("strips CSI private-mode sequences (the real-world cursor restore)", () => {
    expect(stripAnsi(`agent-swarm v1.85.0\n${ESC}[?25h`)).toBe("agent-swarm v1.85.0\n");
  });

  test("strips color CSI sequences", () => {
    expect(stripAnsi(`${ESC}[32mok${ESC}[0m`)).toBe("ok");
  });

  test("strips OSC sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}hello`)).toBe("hello");
    expect(stripAnsi(`${ESC}]8;;https://x${ESC}\\link`)).toBe("link");
  });

  test("strips bare two-char escapes", () => {
    expect(stripAnsi(`${ESC}Mup`)).toBe("up");
  });

  test("leaves plain text alone", () => {
    expect(stripAnsi("agent-swarm v1.85.0")).toBe("agent-swarm v1.85.0");
  });
});

describe("cleanVersion", () => {
  test("real dirty fixture from evals.db → clean semver", () => {
    // Exactly what older runs stored: trailing newline + ESC[?25h from the CLI.
    expect(cleanVersion(`agent-swarm v1.85.0\n${ESC}[?25h`)).toBe("1.85.0");
  });

  test("plain CLI output", () => {
    expect(cleanVersion("agent-swarm v1.85.0")).toBe("1.85.0");
  });

  test("bare semver without the v prefix", () => {
    expect(cleanVersion("1.85.0")).toBe("1.85.0");
  });

  test("prerelease / build suffixes are kept", () => {
    expect(cleanVersion("agent-swarm v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(cleanVersion("v1.2.3+build.5")).toBe("1.2.3+build.5");
  });

  test("color-wrapped version", () => {
    expect(cleanVersion(`${ESC}[32mv1.0.0${ESC}[0m`)).toBe("1.0.0");
  });

  test("no semver token → cleaned text kept (clipped)", () => {
    expect(cleanVersion("hello world")).toBe("hello world");
    expect(cleanVersion("x".repeat(80))).toBe("x".repeat(64));
  });

  test("escape-only / empty / nullish input → null", () => {
    expect(cleanVersion(`${ESC}[?25h`)).toBeNull();
    expect(cleanVersion("   \n ")).toBeNull();
    expect(cleanVersion("")).toBeNull();
    expect(cleanVersion(null)).toBeNull();
    expect(cleanVersion(undefined)).toBeNull();
  });
});
