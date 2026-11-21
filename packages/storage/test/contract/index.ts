import { agentsContract } from "./agents";
import { assetsContract } from "./assets";
import { configContract } from "./config";
import type { ContractEngine } from "./env";
import { extensionsContract } from "./extensions";
import { maintenanceContract } from "./maintenance";
import { modelsContract } from "./models";
import { rbacContract } from "./rbac";
import { runtimePoolsContract } from "./runtime-pools";
import { usersContract } from "./users";

export type { ContractEngine } from "./env";

/** The repository contract suite. Every engine runs all of it. */
export function runStorageContract(engine: ContractEngine): void {
  extensionsContract(engine);
  modelsContract(engine);
  runtimePoolsContract(engine);
  configContract(engine);
  agentsContract(engine);
  maintenanceContract(engine);
  assetsContract(engine);
  usersContract(engine);
  rbacContract(engine);
}
