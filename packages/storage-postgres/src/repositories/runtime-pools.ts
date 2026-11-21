import {
  BaseRuntimePoolsRepository,
  type ControllerRuntimeRow,
  type RemoteControllerRow,
  type RuntimeCacheReleaseRow,
  type RuntimeInstanceRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresRuntimePoolsRepository extends BaseRuntimePoolsRepository {
  listRemoteControllers(): Promise<RemoteControllerRow[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listRemoteControllers");
  }

  setResolvedImage(
    poolId: string,
    update: { name: string; image: string; cpu: number; memoryMb: number; now: string },
  ): Promise<number> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.setResolvedImage");
  }

  listCacheReleases(): Promise<RuntimeCacheReleaseRow[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listCacheReleases");
  }

  claimCacheRelease(id: string, claimedAt: string, staleBefore: string): Promise<number> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.claimCacheRelease");
  }

  listNonOfflinePoolRuntimeIds(poolId: string, controllerId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listNonOfflinePoolRuntimeIds");
  }

  listNonOfflineControllerRuntimeIds(controllerId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listNonOfflineControllerRuntimeIds");
  }

  listControllerRuntimes(controllerId: string): Promise<ControllerRuntimeRow[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listControllerRuntimes");
  }

  listUnadoptedProvisioningIds(controllerId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listUnadoptedProvisioningIds");
  }

  listAgentsForPool<T>(poolId: string): Promise<T[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listAgentsForPool");
  }

  listPendingTaskIds(agentId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listPendingTaskIds");
  }

  listPendingWork<T>(agentId: string): Promise<T[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listPendingWork");
  }

  listRuntimeSessionTaskIds(runtimeId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listRuntimeSessionTaskIds");
  }

  listDispatchedTaskIdsWithoutSession(runtimeId: string): Promise<string[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listDispatchedTaskIdsWithoutSession");
  }

  findBusyRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<{ taskId: string } | null> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.findBusyRuntimeSession");
  }

  listStaleUnpooledRuntimes(cutoff: string): Promise<{ id: string; agent_id: string }[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listStaleUnpooledRuntimes");
  }

  listRuntimesForPool(poolId: string): Promise<RuntimeInstanceRow[]> {
    return notOnPostgresYet("PostgresRuntimePoolsRepository.listRuntimesForPool");
  }
}
