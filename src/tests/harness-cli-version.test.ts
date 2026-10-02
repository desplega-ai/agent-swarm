import { afterEach, expect, spyOn, test } from "bun:test";
import {
  probeHarnessCliVersion,
  reportHarnessModelOutcome,
  resetHarnessCliVersionForTests,
} from "../utils/harness-cli-version";

afterEach(() => resetHarnessCliVersionForTests());

test("pi registration reports the version from its CLI", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: new Response("0.99.2\n").body,
    exited: Promise.resolve(0),
  })) as typeof Bun.spawn);
  try {
    expect(await probeHarnessCliVersion("pi")).toBe("0.99.2");
    expect(spawn).toHaveBeenCalledWith(["pi", "--version"], expect.anything());
  } finally {
    spawn.mockRestore();
  }
});

for (const harness of ["opencode", "dsh", "acp"]) {
  test(`${harness} registration sends an explicit clear instead of preserving a stale version`, async () => {
    expect((await probeHarnessCliVersion(harness)) ?? undefined).toBe("");
  });
}

for (const harness of ["claude", "codex", "pi"]) {
  test(`${harness} probe failure preserves the previously registered version`, async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("temporarily unavailable");
    }) as typeof Bun.spawn);
    try {
      expect((await probeHarnessCliVersion(harness)) ?? undefined).toBeUndefined();
      expect(spawn).toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
}

test("pi version probing does not enable unverified model-outcome reporting", async () => {
  resetHarnessCliVersionForTests({ pi: "0.99.2" });
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  for (const exitCode of [0, 1]) {
    await reportHarnessModelOutcome({
      apiUrl: "http://x",
      agentId: "a",
      harness: "pi",
      model: "m1",
      exitCode,
      failureReason: "unknown model 'm1'",
      fetchImpl,
    });
  }
  expect(bodies).toEqual([]);
});
