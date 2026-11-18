import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { registerAgent, upsertScript } from "./script-helpers";

/** `nobody:nogroup`, the identity `resolveSandboxIdentity()` drops to. */
const UNPRIVILEGED_UID = 65534;

/**
 * The API runs on this host as this user. A root API on Linux with setpriv
 * drops script children to nobody; any other API keeps its own uid.
 */
function expectedChildUid(): { uid: number; dropped: boolean } {
  const euid = process.geteuid?.() ?? -1;
  const dropped = process.platform === "linux" && euid === 0 && Bun.which("setpriv") !== null;
  return { uid: dropped ? UNPRIVILEGED_UID : euid, dropped };
}

const PROBE_TEXT = "api-only-content";

/**
 * Flow `script-sandbox-identity`: a durable script run and the argsSchema
 * extraction at script upsert both run user code under the sandbox identity of
 * the native executor. On a root API the code runs as nobody and cannot read a
 * 0600 file of the API user. On a non-root API both paths keep the API's uid.
 * Both paths still complete: the durable run returns its output and the upsert
 * stores the extracted args JSON schema.
 */
export const scriptSandboxIdentity: Scenario = {
  name: "script-sandbox-identity",
  order: 446,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "sandbox-identity");
    const expected = expectedChildUid();
    const probeDir = mkdtempSync(join(tmpdir(), `e2e-sandbox-identity-${ctx.nonce}-`));
    const probeFile = join(probeDir, "api-only.txt");
    writeFileSync(probeFile, PROBE_TEXT);
    chmodSync(probeFile, 0o600);
    const expectedRead = expected.dropped ? "denied" : PROBE_TEXT;

    try {
      // ── A. durable script run ──
      const source = `export default async function (args: { probe: string }) {
  const g = globalThis as any;
  let read = "denied";
  try { read = await g.Bun.file(args.probe).text(); } catch {}
  return { uid: g.process.getuid(), read };
}`;
      const created = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: { source, args: { probe: probeFile }, scriptName: `e2e-identity-${ctx.nonce}` },
      });
      expectStatus(created, [201], "launch the durable identity run");
      const runId = asString(asRecord(created.json).id, "run id");
      let run: Record<string, unknown> = {};
      const done = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/script-runs/${runId}`);
        expectStatus(response, [200], "poll the durable identity run");
        run = asRecord(asRecord(response.json).run);
        return ["completed", "failed", "cancelled", "aborted_limit"].includes(String(run.status));
      }, 60_000);
      expect(done, `durable identity run never finished: ${JSON.stringify(run).slice(0, 400)}`);
      expect(
        run.status === "completed",
        `durable identity run must complete: ${JSON.stringify(run).slice(0, 400)}`,
      );
      const output = asRecord(run.output);
      expect(
        output.uid === expected.uid,
        `durable run uid ${String(output.uid)}, expected ${expected.uid}`,
      );
      expect(
        output.read === expectedRead,
        `durable run read of a 0600 API file: got ${JSON.stringify(output.read)}, expected ${JSON.stringify(expectedRead)}`,
      );

      // ── B. argsSchema extraction at upsert ──
      const name = `e2e-identity-schema-${ctx.nonce}`;
      const schemaSource = `import { z } from "zod";
const g = globalThis as any;
let read = "denied";
try { read = await g.Bun.file(${JSON.stringify(probeFile)}).text(); } catch {}
export const argsSchema = z.object({
  n: z.number().describe("uid=" + g.process.getuid() + ";read=" + read),
});
export default async function (args: z.infer<typeof argsSchema>) {
  return { n: args.n };
}`;
      const saved = await upsertScript(ctx, agentId, { name, source: schemaSource });
      const detail = await ctx.api("GET", `/api/scripts/${saved.id}`);
      expectStatus(detail, [200], "get the identity script");
      const argsSchema = asRecord(asRecord(asRecord(detail.json).script).argsJsonSchema);
      const n = asRecord(asRecord(argsSchema.properties).n);
      expect(
        n.type === "number" && JSON.stringify(argsSchema.required) === JSON.stringify(["n"]),
        `argsJsonSchema was not extracted: ${JSON.stringify(argsSchema).slice(0, 400)}`,
      );
      expect(
        n.description === `uid=${expected.uid};read=${expectedRead}`,
        `schema extraction identity: got ${JSON.stringify(n.description)}, expected uid=${expected.uid};read=${expectedRead}`,
      );
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  },
};
