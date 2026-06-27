import { reembedAllScripts } from "./embeddings";

export async function runScriptsMaintenanceCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand !== "reembed") {
    throw new Error("Unknown scripts command. Usage: scripts reembed");
  }
  await reembedAllScripts();
}
