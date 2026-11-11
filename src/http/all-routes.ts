/**
 * Side-effect import of every HTTP handler module so their `route()` calls
 * populate `routeRegistry`. Single source of truth for "all registered
 * routes" — consumed by scripts/generate-openapi.ts and
 * scripts/check-rbac-coverage.ts.
 *
 * When you add a new handler file, add its import HERE (keep the existing
 * order — OpenAPI output and route matching in the generators follow
 * registration order).
 */
import "./active-sessions";
import "./agents";
import "./approval-requests";
import "./apps";
import "./assets";
import "./budgets";
import "./codex-oauth-device";
import "./codex-oauth-accounts";
import "./codex-oauth-keep-warm";
import "./comb";
import "./config";
import "./pool-keys";
import "./context";
import "./core";
import "./db-query";

import "./api-keys";
import "./events";
import "./extensions";
import "./favorites";
import "./checklist";
import "./fs";
import "./github-token";
import "./heartbeat";
import "./inbox-state";
import "./integrations";
import "./kv";
import "./memory";
import "./metrics";
import "./model-groups";
import "./model-profiles";
import "./models-catalog";
import "./object-webhooks";
import "./oauth-locks";
import "./oauth-callback";
import "./oauth-generic";
import "./onboarding";
import "./page-proxy";
import "./agentfs-proxy";
import "./pages";
import "./pages-public";
import "./prompt-templates";
import "./poll";
import "./pricing";
import "./repos";
import "./request-composition";
import "./realtime";
import "./rooms";
import "./schedules";
import "./script-connections";
import "./script-runs";
import "./script-connection-proxy";
import "./session-data";
import "./savings";
import "./savings-calibration";
import "./sessions";
import "./skills";
import "./slack-events";
import "./slack-inbound";
import "./scripts";
import "./mcp-bridge";
import "./mcp-oauth";
import "./mcp-servers";
import "./stats";
import "./status";
import "./tasks";
import "./task-templates";
import "./telemetry-ui";
import "./tool-hooks";
import "./trackers/jira";
import "./trackers/linear";
import "./ranking";
import "./used-by";
import "./improvements";
import "./fleet-benchmark";
import "./user-roles";
import "./users";
import "./webhooks";
import "./workflow-events";
import "./workflows";
import "./x";

import "./runtime-pools";
import "./controllers-connect";
