import { createMetricVersion, getMetric, getMetricVersions } from "../be/db";
import type { MetricSnapshot, MetricVersion } from "../types";

export function snapshotMetric(metricId: string, changedByAgentId?: string): MetricVersion {
  const metric = getMetric(metricId);
  if (!metric) {
    throw new Error(`Metric ${metricId} not found — cannot create snapshot`);
  }

  const existingVersions = getMetricVersions(metricId);
  const maxVersion = existingVersions.length > 0 ? existingVersions[0]!.version : 0;
  const nextVersion = maxVersion + 1;

  const snapshot: MetricSnapshot = {
    title: metric.title,
    description: metric.description,
    definition: metric.definition,
  };

  return createMetricVersion({
    metricId,
    version: nextVersion,
    snapshot,
    changedByAgentId,
  });
}
