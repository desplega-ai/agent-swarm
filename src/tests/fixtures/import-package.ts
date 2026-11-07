import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

/** Write a package to a fresh temp dir; `removePackages` deletes them all. */
export async function writePackage(files: Record<string, string>, dir?: string): Promise<string> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), "swarm-import-")));
  if (!dir) dirs.push(root);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
  return root;
}

export async function removePackages(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

export const WORKFLOW_YAML = (name: string, template = "Review it") => `name: ${name}
description: Review flow
definition:
  nodes:
    - id: review
      type: agent-task
      config:
        template: ${template}
`;

export const SKILL_MD = (name: string, body = "# Review guide") =>
  `---\nname: ${name}\ndescription: How to review\n---\n\n${body}\n`;

export const SCRIPT = "export default async function run() {\n  return { ok: true };\n}\n";
