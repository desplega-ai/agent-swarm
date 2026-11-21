import { agentsContract } from "./agents";
import { configContract } from "./config";
import type { ContractEngine } from "./env";
import { extensionsContract } from "./extensions";
import { modelsContract } from "./models";
import { pagesContract } from "./pages";
import { runtimePoolsContract } from "./runtime-pools";
import { scriptsContract } from "./scripts";
import { skillsContract } from "./skills";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
  modelsContract(engine);
  runtimePoolsContract(engine);
  configContract(engine);
  agentsContract(engine);
  scriptsContract(engine);
  pagesContract(engine);
  skillsContract(engine);
}
