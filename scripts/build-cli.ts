import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outfile = "dist/cli.js";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await Bun.$`bun build ./apps/swarm/src/cli.tsx --target=node --format=esm --splitting --outdir=dist --entry-naming=cli.js`.quiet();

const built = await readFile(outfile, "utf8");
const withNodeShebang = built.replace(/^#!\/usr\/bin\/env bun/, "#!/usr/bin/env node");

if (!withNodeShebang.startsWith("#!/usr/bin/env node")) {
  throw new Error(`Expected ${outfile} to start with a node shebang`);
}

await writeFile(outfile, withNodeShebang);
await chmod(outfile, 0o755);
