/**
 * Regression test for the `/api/services` response-shape bug in
 * `src/commands/artifact.ts` (artifactList / artifactStop).
 *
 * The endpoint returns `{ services: [...] }`, but earlier the code
 * cast the JSON as a bare `Array<...>` and crashed with
 * `services.filter is not a function`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { runArtifact } from "../commands/artifact";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;

let capturedOut: string[] = [];
let capturedErr: string[] = [];

beforeAll(() => {
  console.log = (...args: unknown[]) => {
    capturedOut.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    capturedErr.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedOut = [];
  capturedErr = [];
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runArtifact('list')", () => {
  test("handles wrapped { services: [] } without throwing", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse({ services: [] })));

    await expect(runArtifact("list", { additionalArgs: [] })).resolves.toBeUndefined();
    expect(capturedOut.join("\n")).toContain("No active artifacts");
    expect(capturedErr.join("\n")).not.toContain("services.filter");
  });

  test("renders artifact rows from { services: [...] }", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        jsonResponse({
          services: [
            {
              name: "artifact-testart",
              agentId: "agent-xyz",
              status: "healthy",
              metadata: {
                type: "artifact",
                artifactName: "testart",
                port: 4242,
                publicUrl: "https://testart.loca.lt",
              },
            },
          ],
        }),
      ),
    );

    await expect(runArtifact("list", { additionalArgs: [] })).resolves.toBeUndefined();
    const out = capturedOut.join("\n");
    expect(out).toContain("testart");
    expect(out).toContain("4242");
    expect(out).toContain("https://testart.loca.lt");
    expect(out).toContain("healthy");
  });

  test("falls back to [] when response omits services key", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse({})));

    await expect(runArtifact("list", { additionalArgs: [] })).resolves.toBeUndefined();
    expect(capturedOut.join("\n")).toContain("No active artifacts");
  });
});
