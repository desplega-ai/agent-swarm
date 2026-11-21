import {
  BaseSavingsRepository,
  type SavingsLinkRow,
  type SavingsScriptBucket,
  sql,
} from "@desplega/storage";

export class SqliteSavingsRepository extends BaseSavingsRepository {
  async replaceScriptBucket(b: SavingsScriptBucket): Promise<void> {
    await this.db.run(sql`
      INSERT OR REPLACE INTO automation_savings_daily
        (day, "jobKind", "jobId", "jobKey", "jobName", "subKind", runs, "countedRuns", "effectRuns", "opsSum", "computeSecs", "modelVersion", "computedAt")
      VALUES (${b.day}, 'script', ${b.jobId}, ${b.jobKey}, ${b.jobName}, ${b.subKind}, ${b.runs}, ${b.countedRuns},
        ${b.effectRuns}, ${b.opsSum}, ${b.computeSecs}, ${b.modelVersion}, ${b.computedAt})`);
  }

  async replaceLink(l: SavingsLinkRow): Promise<void> {
    await this.db.run(sql`
      INSERT OR REPLACE INTO automation_savings_links
        (day, "parentJobId", "childKind", "childJobId", "linkKind", n, "actualUsd", "keptUsd", "modelVersion", "computedAt")
      VALUES (${l.day}, ${l.parentJobId}, ${l.childKind}, ${l.childJobId}, ${l.linkKind}, ${l.n}, ${l.actualUsd},
        ${l.keptUsd}, ${l.modelVersion}, ${l.computedAt})`);
  }
}
