/** A real child that tries to write `target` the way production code would (agent-swarm-ops#884). */
import { writeFile } from "node:fs/promises";

const [target, operation] = process.argv.slice(2) as [string, string];
switch (operation) {
  case "bun-write":
    await Bun.write(target, "changed by child");
    break;
  case "named-writeFile":
    // An ESM named import is bound before any test code could patch the module object.
    await writeFile(target, "changed by child");
    break;
  case "grandchild": {
    // Same shape as the e2e suites: an explicit env that does not inherit ours.
    const grandchild = Bun.spawn([process.execPath, import.meta.path, target, "bun-write"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await grandchild.exited);
    break;
  }
  default:
    throw new Error(`Unknown probe: ${operation}`);
}
console.log(`wrote ${target}`);
