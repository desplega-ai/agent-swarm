import type {
  SavingsAgentSpendRow,
  SavingsBucketSize,
  SavingsCalibrationSessionRow,
  SavingsDayCountRow,
  SavingsDispatchStepRow,
  SavingsEffectStepRow,
  SavingsOwnedTaskRow,
  SavingsReader,
  SavingsScriptEffectRow,
  SavingsScriptLinkRow,
  SavingsScriptRunRow,
  SavingsSpan,
  SavingsStepFactRow,
  SavingsTaskTreeRow,
  SavingsTriggerRow,
  SavingsWorkflowLinkRow,
} from "@desplega/storage";
import {
  BaseSavingsRepository,
  type SavingsLinkRow,
  type SavingsScriptBucket,
  sql,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

// SQLite's INSERT OR REPLACE deletes the conflicting row and inserts a new
// one: every column the statement does not name goes back to its default and
// the row gets a new rowid. The upserts below reset the same columns.
export class PostgresSavingsRepository extends BaseSavingsRepository {
  async replaceScriptBucket(b: SavingsScriptBucket): Promise<void> {
    await this.db.run(sql`
      INSERT INTO automation_savings_daily
        (day, "jobKind", "jobId", "jobKey", "jobName", "subKind", runs, "countedRuns", "effectRuns", "opsSum", "computeSecs", "modelVersion", "computedAt")
      VALUES (${b.day}, 'script', ${b.jobId}, ${b.jobKey}, ${b.jobName}, ${b.subKind}, ${b.runs}, ${b.countedRuns},
        ${b.effectRuns}, ${b.opsSum}, ${b.computeSecs}, ${b.modelVersion}, ${b.computedAt})
      ON CONFLICT (day, "jobKind", "jobId", "subKind") DO UPDATE SET
        "jobKey" = excluded."jobKey", "jobName" = excluded."jobName", runs = excluded.runs,
        "countedRuns" = excluded."countedRuns", "effectRuns" = excluded."effectRuns",
        "opsSum" = excluded."opsSum", "computeSecs" = excluded."computeSecs",
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt",
        "schedRuns" = DEFAULT, "schedEffectRuns" = DEFAULT, "eventRuns" = DEFAULT,
        "effectOpsSum" = DEFAULT, "agentTasks" = DEFAULT, "agentUsd" = DEFAULT,
        "agentMs" = DEFAULT, "followupUsd" = DEFAULT, "recordedLlmUsd" = DEFAULT,
        "estimatedLlmUsd" = DEFAULT, "childTaskUsd" = DEFAULT, "childTaskMs" = DEFAULT,
        "_rowid" = DEFAULT`);
  }

  async replaceLink(l: SavingsLinkRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO automation_savings_links
        (day, "parentJobId", "childKind", "childJobId", "linkKind", n, "actualUsd", "keptUsd", "modelVersion", "computedAt")
      VALUES (${l.day}, ${l.parentJobId}, ${l.childKind}, ${l.childJobId}, ${l.linkKind}, ${l.n}, ${l.actualUsd},
        ${l.keptUsd}, ${l.modelVersion}, ${l.computedAt})
      ON CONFLICT (day, "parentJobId", "childKind", "childJobId", "linkKind") DO UPDATE SET
        n = excluded.n, "actualUsd" = excluded."actualUsd", "keptUsd" = excluded."keptUsd",
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt",
        "_rowid" = DEFAULT`);
  }

  listScriptAwaitCounts(
    names: string[],
    reader?: SavingsReader,
  ): Promise<{ name: string; aw: number }[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listScriptAwaitCounts");
  }

  listDispatchingScripts(names: string[], reader?: SavingsReader): Promise<string[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listDispatchingScripts");
  }

  countWorkflowRunsInSpan(
    workflowId: string,
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<number> {
    return notOnPostgresYet("PostgresSavingsRepository.countWorkflowRunsInSpan");
  }

  workflowRunsByTrigger(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsTriggerRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowRunsByTrigger");
  }

  workflowScheduledEffectRuns(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsDayCountRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowScheduledEffectRuns");
  }

  workflowStepFacts(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsStepFactRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowStepFacts");
  }

  workflowAgentSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsAgentSpendRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowAgentSpend");
  }

  workflowFollowupSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<{ d: string; fup: number | null }[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowFollowupSpend");
  }

  workflowEffectSteps(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsEffectStepRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.workflowEffectSteps");
  }

  scriptRunsByName(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<SavingsScriptRunRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.scriptRunsByName");
  }

  scriptEffectRuns(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    dispatchers: string[],
    reader?: SavingsReader,
  ): Promise<SavingsScriptEffectRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.scriptEffectRuns");
  }

  subWorkflowLinks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsWorkflowLinkRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.subWorkflowLinks");
  }

  stampedWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.stampedWorkflowLinks");
  }

  stampedScriptLinks(
    span: SavingsSpan,
    inlineName: string,
    reader?: SavingsReader,
  ): Promise<SavingsScriptLinkRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.stampedScriptLinks");
  }

  listStepTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listStepTasks");
  }

  listNodeTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listNodeTasks");
  }

  listTaskTrees(
    roots: string[],
    maxDepth: number,
    reader?: SavingsReader,
  ): Promise<SavingsTaskTreeRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listTaskTrees");
  }

  listDispatchSteps(
    workflowId: string,
    span: SavingsSpan,
    nodeIds: string[],
    reader?: SavingsReader,
  ): Promise<SavingsDispatchStepRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listDispatchSteps");
  }

  listCalibrationSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<SavingsCalibrationSessionRow[]> {
    return notOnPostgresYet("PostgresSavingsRepository.listCalibrationSessions");
  }
}
