import type { ContractEngine } from "./env";
import { extensionsContract } from "./extensions";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
}
