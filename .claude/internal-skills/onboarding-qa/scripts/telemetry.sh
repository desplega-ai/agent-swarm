#!/usr/bin/env bash
# Read-only queries against the telemetry ClickHouse (desplega-labs, container telemetry-clickhouse).
#
#   telemetry.sh funnel [days]   real-user install + /setup funnel (default 30 days)
#   telemetry.sh runs [hours]    QA installs: every org that sent an onboarding-qa event (default 24 h)
#   telemetry.sh org <org_id>    one install's event timeline, Barcelona time
#
# "Real users" = environment production, no internal event, and no onboarding-qa
# event on the same org (QA boxes send production events until they are tagged).
# Counts are installs (actor_org_id): one person can make several.
set -euo pipefail

HOST="${ONBOARDING_QA_TELEMETRY_HOST:-desplega-labs}"
CONTAINER="${ONBOARDING_QA_TELEMETRY_CONTAINER:-telemetry-clickhouse}"

ch() {
  ssh "$HOST" docker exec -i "$CONTAINER" clickhouse-client --multiquery \
    --format PrettyCompactMonoBlock "$@"
}

real_users='product = '"'"'agent-swarm'"'"' AND environment = '"'"'production'"'"'
  AND actor_org_id NOT IN (SELECT DISTINCT actor_org_id FROM telemetry.raw_events
    WHERE (is_internal OR environment = '"'"'onboarding-qa'"'"') AND actor_org_id IS NOT NULL)'

cmd_funnel() {
  local days="${1:-30}"
  [[ "$days" =~ ^[0-9]+$ ]] || { echo "days must be an integer" >&2; exit 2; }
  ch --param_days="$days" <<SQL
SELECT event, uniqExact(actor_org_id) AS installs
FROM telemetry.raw_events
WHERE $real_users AND occurred_at > now() - INTERVAL {days:UInt32} DAY
  AND event IN ('server.started', 'agent.registered', 'task.created', 'task.completed',
    'onboarding.started', 'onboarding.dismissed', 'onboarding.completed', 'onboarding.first_task_completed')
GROUP BY event ORDER BY installs DESC;

SELECT JSONExtractString(properties_json, 'step') AS step,
  uniqExactIf(actor_org_id, event = 'onboarding.step_viewed') AS viewed,
  uniqExactIf(actor_org_id, event = 'onboarding.step_completed') AS completed,
  uniqExactIf(actor_org_id, event = 'onboarding.step_skipped') AS skipped,
  uniqExactIf(actor_org_id, event = 'onboarding.step_failed') AS failed
FROM telemetry.raw_events
WHERE $real_users AND occurred_at > now() - INTERVAL {days:UInt32} DAY AND event LIKE 'onboarding.step_%'
GROUP BY step
ORDER BY indexOf(['connect', 'name', 'ai', 'agents', 'memory', 'integrations', 'first_task'], step);

SELECT JSONExtractString(properties_json, 'step') AS step,
  JSONExtractString(properties_json, 'error_class') AS error_class,
  count() AS events, uniqExact(actor_org_id) AS installs
FROM telemetry.raw_events
WHERE $real_users AND occurred_at > now() - INTERVAL {days:UInt32} DAY AND event = 'onboarding.step_failed'
GROUP BY step, error_class ORDER BY installs DESC;

SELECT count() AS booted,
  countIf(first_agent > 0) AS got_an_agent,
  countIf(first_agent > 0 AND first_agent - first_boot <= 3600) AS agent_within_1h,
  round(quantileIf(0.5)(first_agent - first_boot, first_agent > 0)) AS p50_secs_to_agent
FROM (
  SELECT actor_org_id,
    minIf(toUnixTimestamp(occurred_at), event = 'server.started') AS first_boot,
    minIf(toUnixTimestamp(occurred_at), event = 'agent.registered') AS first_agent
  FROM telemetry.raw_events
  WHERE $real_users AND occurred_at > now() - INTERVAL {days:UInt32} DAY
  GROUP BY actor_org_id
  HAVING first_boot > 0
);
SQL
}

cmd_runs() {
  local hours="${1:-24}"
  [[ "$hours" =~ ^[0-9]+$ ]] || { echo "hours must be an integer" >&2; exit 2; }
  ch --param_hours="$hours" <<'SQL'
SELECT actor_org_id,
  formatDateTime(toTimeZone(min(occurred_at), 'Europe/Madrid'), '%m-%d %H:%i') AS first_bcn,
  formatDateTime(toTimeZone(max(occurred_at), 'Europe/Madrid'), '%m-%d %H:%i') AS last_bcn,
  count() AS events,
  countIf(environment = 'production') AS untagged_events,
  max(swarm_version) AS version
FROM telemetry.raw_events
WHERE product = 'agent-swarm' AND actor_org_id IN (
  SELECT DISTINCT actor_org_id FROM telemetry.raw_events
  WHERE environment = 'onboarding-qa' AND occurred_at > now() - INTERVAL {hours:UInt32} HOUR)
GROUP BY actor_org_id ORDER BY min(occurred_at);
SQL
}

cmd_org() {
  local org="$1"
  [[ "$org" =~ ^org_[A-Za-z0-9]+$ ]] || { echo "org id must look like org_<id>" >&2; exit 2; }
  ch --param_org="$org" <<'SQL'
SELECT formatDateTime(toTimeZone(min(occurred_at), 'Europe/Madrid'), '%H:%i:%S') AS first_bcn,
  formatDateTime(toTimeZone(max(occurred_at), 'Europe/Madrid'), '%H:%i:%S') AS last_bcn,
  event,
  JSONExtractString(properties_json, 'step') AS step,
  JSONExtractString(properties_json, 'error_class') AS error_class,
  environment, count() AS n
FROM telemetry.raw_events
WHERE actor_org_id = {org:String}
GROUP BY event, step, error_class, environment
ORDER BY min(occurred_at);
SQL
}

case "${1:-}" in
  funnel) cmd_funnel "${2:-}" ;;
  runs) cmd_runs "${2:-}" ;;
  org) cmd_org "${2:?org id}" ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
