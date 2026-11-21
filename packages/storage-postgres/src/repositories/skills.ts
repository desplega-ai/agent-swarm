import {
  BaseSkillsRepository,
  type NewSkillInvocation,
  type SkillUsageAgentStatsRow,
  type SkillUsageDayRow,
  type SkillUsageKeyCountRow,
  type SkillUsageSkillRow,
  type SkillUsageTotalsRow,
  type SkillUsageUnusedSkillRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSkillsRepository extends BaseSkillsRepository {
  searchRankedSkills<T>(
    match: string,
    exactName: string,
    limit: number,
    columns: string,
  ): Promise<T[]> {
    return notOnPostgresYet("PostgresSkillsRepository.searchRankedSkills");
  }

  insertSkillInvocation(invocation: NewSkillInvocation): Promise<boolean> {
    return notOnPostgresYet("PostgresSkillsRepository.insertSkillInvocation");
  }

  usageTotals(since: string | null): Promise<SkillUsageTotalsRow | null> {
    return notOnPostgresYet("PostgresSkillsRepository.usageTotals");
  }

  usageDaily(since: string | null, tzOffsetMinutes: number): Promise<SkillUsageDayRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.usageDaily");
  }

  usageByHarness(since: string | null): Promise<SkillUsageKeyCountRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.usageByHarness");
  }

  usageBySkill(since: string | null): Promise<SkillUsageSkillRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.usageBySkill");
  }

  usageByAgent(since: string | null): Promise<SkillUsageAgentStatsRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.usageByAgent");
  }

  unusedSkills(since: string | null): Promise<SkillUsageUnusedSkillRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.unusedSkills");
  }

  detailDaily(
    skillId: string,
    since: string | null,
    tzOffsetMinutes: number,
  ): Promise<SkillUsageDayRow[]> {
    return notOnPostgresYet("PostgresSkillsRepository.detailDaily");
  }
}
