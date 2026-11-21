import {
  BaseSavingsRepository,
  type SavingsLinkRow,
  type SavingsScriptBucket,
  sql,
} from "@desplega/storage";

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
}
