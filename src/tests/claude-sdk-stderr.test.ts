import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { spawnClaudeSdkProcess } from "../providers/claude-sdk-session";

describe("Claude SDK stderr forwarding", () => {
  test("forwards whole lines when a write splits a line, then the unterminated tail", async () => {
    const received: string[] = [];
    const proc = spawnClaudeSdkProcess(
      {
        command: "/bin/sh",
        args: [
          "-c",
          "printf 'token=abc' >&2; sleep 0.2; printf 'def\\nnext\\n' >&2; printf tail >&2",
        ],
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        signal: new AbortController().signal,
      },
      [],
      [],
      [],
      (text) => received.push(text),
    );
    await proc.exited;
    await proc.stderrDone;
    expect(received).toEqual(["token=abcdef\nnext\n", "tail"]);
  });
});
