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
import "./budgets";
import "./codex-oauth-keep-warm";
import "./config";
import "./context";
import "./db-query";
import "./ecosystem";

import "./api-keys";
import "./events";
import "./favorites";
import "./fs";
import "./heartbeat";
import "./inbox-state";
import "./integrations";
import "./kv";
import "./memory";
import "./metrics";
import "./oauth-locks";
import "./oauth-generic";
import "./page-proxy";
import "./pages";
import "./pages-public";
import "./prompt-templates";
import "./poll";
import "./pricing";
import "./repos";
import "./schedules";
import "./script-runs";
import "./script-connection-proxy";
import "./session-data";
import "./sessions";
import "./skills";
import "./scripts";
import "./mcp-bridge";
import "./mcp-oauth";
import "./mcp-servers";
import "./stats";
import "./status";
import "./tasks";
import "./task-templates";
import "./trackers/jira";
import "./trackers/linear";
import "./users";
import "./webhooks";
import "./workflow-events";
import "./workflows";
import "./x";
