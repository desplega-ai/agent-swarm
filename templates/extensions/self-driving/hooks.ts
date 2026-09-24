import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";

// The loader validates the operator config against this schema. The scripts
// cannot see ctx.config, so they read the stored config through
// extension_list and apply the same defaults (see scripts/*.ts).
export const config = z.object({
  classifier: z.enum(["rules", "llm", "jev"]).default("rules"),
  threshold: z.number().int().min(1).default(3),
  repos: z.array(z.object({ project: z.string().min(1), repo: z.string().min(1) })).default([]),
  dispatch: z.literal(false).default(false),
});

const manifest = {
  name: "self-driving",
  description:
    "MVP of the self-driving loop: ingest Sentry-shaped signals, classify, cluster by fingerprint, and propose a dry-run task. Never creates tasks.",
  version: "0.1.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

// No hook events: the loop runs in the bundled workflow and scripts. The hooks
// file is still required by the manifest, and its config export is the only
// place the loader validates operator config.
const extension: SwarmExtension<typeof manifest> = () => {};

export default extension;
