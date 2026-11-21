import type { ContractEngine } from "./env";
import { extensionsContract } from "./extensions";
import { modelsContract } from "./models";
import { runtimePoolsContract } from "./runtime-pools";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
  modelsContract(engine);
  runtimePoolsContract(engine);
}
