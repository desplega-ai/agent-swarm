import {
  BaseTasksRepository,
  type HumanFreeClassifyInput,
  type SqlQuery,
  type TaskLineageRow,
  type TaskListFields,
  type TaskListFilters,
  type TaskListPage,
  type TaskRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresTasksRepository extends BaseTasksRepository {
  listDeliveredSlackMessageTs(channelId: string, threadTs: string): Promise<(string | null)[]> {
    return notOnPostgresYet("PostgresTasksRepository.listDeliveredSlackMessageTs");
  }

  protected insertionOrder(alias?: string): SqlQuery {
    return notOnPostgresYet("PostgresTasksRepository.insertionOrder");
  }

  listSupersededWithUnsettledDependents(
    finishedBefore: string,
    finishedAfter: string,
    neverStartedStatuses: readonly string[],
  ): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return notOnPostgresYet("PostgresTasksRepository.listSupersededWithUnsettledDependents");
  }

  listTasksDispatchedFrom(taskIds: readonly string[]): Promise<TaskRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listTasksDispatchedFrom");
  }

  countAgentDispatchesInThread(
    channelId: string,
    threadTs: string,
    creatorAgentId: string,
    since: string,
  ): Promise<number> {
    return notOnPostgresYet("PostgresTasksRepository.countAgentDispatchesInThread");
  }

  listTasks(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: TaskListFields,
  ): Promise<Record<string, unknown>[]> {
    return notOnPostgresYet("PostgresTasksRepository.listTasks");
  }

  protected taskSearchCondition(search: string, purpose: "page" | "count"): Promise<SqlQuery> {
    return notOnPostgresYet("PostgresTasksRepository.taskSearchCondition");
  }

  listTaskDescendants(startId: string, maxDepth: number, limit: number): Promise<TaskLineageRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listTaskDescendants");
  }

  listTaskLineageRows(ids: readonly string[]): Promise<TaskLineageRow[]> {
    return notOnPostgresYet("PostgresTasksRepository.listTaskLineageRows");
  }

  getTaskFtsIndexedThrough(): Promise<number | null> {
    return notOnPostgresYet("PostgresTasksRepository.getTaskFtsIndexedThrough");
  }

  indexTaskFtsBatch(batchSize: number): Promise<{ changes: number; done: boolean }> {
    return notOnPostgresYet("PostgresTasksRepository.indexTaskFtsBatch");
  }

  mainDatabaseFile(): Promise<string | null> {
    return notOnPostgresYet("PostgresTasksRepository.mainDatabaseFile");
  }

  repointDependents(
    supersededId: string,
    resumeTaskId: string,
    statuses: readonly string[],
  ): Promise<{ id: string; agentId: string | null }[]> {
    return notOnPostgresYet("PostgresTasksRepository.repointDependents");
  }

  classifyHumanFree(input: HumanFreeClassifyInput): Promise<boolean> {
    return notOnPostgresYet("PostgresTasksRepository.classifyHumanFree");
  }

  enqueueHumanFreeWork(
    taskIds: readonly string[],
    scope: "self" | "children",
    hops: number,
  ): Promise<void> {
    return notOnPostgresYet("PostgresTasksRepository.enqueueHumanFreeWork");
  }

  humanFreeAffected(seedIds: readonly string[], limit: number): Promise<string[]> {
    return notOnPostgresYet("PostgresTasksRepository.humanFreeAffected");
  }

  applyHumanFreeBatch(affected: readonly string[]): Promise<number> {
    return notOnPostgresYet("PostgresTasksRepository.applyHumanFreeBatch");
  }

  humanFreeUnfinished(batch: readonly string[]): Promise<string[]> {
    return notOnPostgresYet("PostgresTasksRepository.humanFreeUnfinished");
  }

  listChildPage(
    parentId: string,
    after: number,
    limit: number,
  ): Promise<{ id: string; position: number }[]> {
    return notOnPostgresYet("PostgresTasksRepository.listChildPage");
  }

  findOpenChannelChecklistItem(
    scope: string,
    userId: string | null,
    adapter: string,
  ): Promise<{ id: string } | null> {
    return notOnPostgresYet("PostgresTasksRepository.findOpenChannelChecklistItem");
  }

  listTaskAttachmentUrls(taskId: string): Promise<{ kind: string; url: string | null }[]> {
    return notOnPostgresYet("PostgresTasksRepository.listTaskAttachmentUrls");
  }

  releasePendingPoolTask(taskId: string, agentId: string, now: string): Promise<number> {
    return notOnPostgresYet("PostgresTasksRepository.releasePendingPoolTask");
  }

  listSupersededWaitMembers(): Promise<{ taskId: string; resumeTaskId: string }[]> {
    return notOnPostgresYet("PostgresTasksRepository.listSupersededWaitMembers");
  }

  repointWaitMembers(taskId: string, resumeTaskId: string, now: string): Promise<void> {
    return notOnPostgresYet("PostgresTasksRepository.repointWaitMembers");
  }
}
