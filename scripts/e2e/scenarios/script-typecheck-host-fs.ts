import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./script-helpers";

type Outcome = { status: number; text: string; shape: string };

/**
 * Flow `script-typecheck-host-fs`: the `script_upsert` typecheck reads only the
 * script source plus the bundled SDK, lib and zod declarations. A script that
 * points `/// <reference path>`, an `import("...")` type query or a relative
 * import at a host file gets no content of it back, and the diagnostics for an
 * existing host file match those for a missing one.
 */
export const scriptTypecheckHostFs: Scenario = {
  name: "script-typecheck-host-fs",
  order: 452,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "typecheck-host-fs");
    const dir = mkdtempSync(join(tmpdir(), `e2e-typecheck-host-fs-${ctx.nonce}-`));
    const existing = join(dir, "dev-config.ts");
    const missing = join(dir, "does-not-exist.ts");
    const marker = `host-secret-${ctx.nonce}`;
    writeFileSync(existing, `export const SECRET_EXPORT = "${marker}";\n`);
    chmodSync(existing, 0o600);

    const probes: Record<string, (path: string) => string> = {
      "reference-path": (path) =>
        `/// <reference path="${path}" />\nexport default async function () { return 1; }\n`,
      "import-type": (path) =>
        `type T = typeof import("${path}");\nconst leak: 0 = null as unknown as T["SECRET_EXPORT"];\nexport default async function () { return leak; }\n`,
    };

    const upsert = async (label: string, source: string): Promise<Outcome> => {
      const response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId,
        body: { name: `e2e-tc-host-fs-${label}-${ctx.nonce}`, source },
      });
      expectStatus(response, [200, 400], `upsert probe ${label}`);
      const body = asRecord(response.json);
      // Compare code, message and position: the caret width tracks the path length.
      const shape = JSON.stringify({
        status: response.status,
        error: body.error,
        structured: (Array.isArray(body.structured) ? body.structured : []).map((d) => {
          const diag = asRecord(d);
          return [diag.code, String(diag.message).replaceAll(existing, "<P>").replaceAll(missing, "<P>"), diag.line, diag.column];
        }),
      });
      return { status: response.status, text: response.text, shape };
    };

    try {
      // Positive control: a host file the compiler must still read (zod) resolves.
      const zod = await upsert(
        "zod",
        `import { z } from "zod";\nimport * as zm from "zod/mini";\nexport default async function () { return z.string().parse(String(zm.string())); }\n`,
      );
      expect(zod.status === 200, `zod import must still typecheck: ${zod.text.slice(0, 400)}`);

      for (const [label, probe] of Object.entries(probes)) {
        const hit = await upsert(`${label}-existing`, probe(existing));
        const miss = await upsert(`${label}-missing`, probe(missing));
        expect(
          !hit.text.includes(marker),
          `${label}: typecheck leaked host file content: ${hit.text.slice(0, 400)}`,
        );
        expect(hit.status === 400, `${label}: a host file must not satisfy the typecheck`);
        expect(
          hit.shape === miss.shape,
          `${label}: existing and missing host paths must look the same: ${hit.shape} vs ${miss.shape}`,
        );
      }

      // A relative import resolves against the virtual script dir, never the API's source tree.
      const relative = await upsert(
        "relative",
        `type T = typeof import("./be/scripts/typecheck");\nexport default async function () { return 1; }\n`,
      );
      expect(
        relative.status === 400 && relative.text.includes("TS2307"),
        `relative import must not resolve a host module: ${relative.text.slice(0, 400)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
