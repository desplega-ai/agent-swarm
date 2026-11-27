import fs from "node:fs";
import promises from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installProfileWriteGuard } from "./profile-write-guard";

const [sandbox, paths, target, operation] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
installProfileWriteGuard(sandbox, JSON.parse(paths));
// Every probe first proves that the same API can write inside the sandbox.
await promises.mkdir(sandbox, { recursive: true });
const source = join(sandbox, "source");
await Bun.write(source, "sandbox write allowed");
async function write(path: string) {
  switch (operation) {
    case "bun":
      return Bun.write(path, "changed");
    case "bun-file":
      return Bun.write(Bun.file(path), "changed");
    case "bun-url":
      return Bun.write(pathToFileURL(path), "changed");
    case "writeFile":
      return promises.writeFile(path, "changed");
    case "rename":
      return promises.rename(source, path);
    case "rename-source":
      return promises.rename(path, join(sandbox, "moved"));
    case "mkdir":
      return promises.mkdir(path);
    case "open":
      return (await promises.open(path, "w")).close();
    case "writeFileSync":
      return fs.writeFileSync(path, "changed");
    case "renameSync":
      return fs.renameSync(source, path);
    case "mkdirSync":
      return fs.mkdirSync(path);
    case "openSync":
      return fs.closeSync(fs.openSync(path, "w"));
    default:
      throw new Error(`Unknown probe: ${operation}`);
  }
}
const allowed = join(sandbox, `${operation}-${crypto.randomUUID()}`);
if (operation === "rename-source") await Bun.write(allowed, "allowed source");
await write(allowed);
await Bun.write(source, "sandbox write allowed");
await write(target);
