import { generateOpenApiSpec } from "../apps/swarm/src/http/openapi";
// Import all handler files to trigger route() registrations
import "../apps/swarm/src/http/active-sessions";
import "../apps/swarm/src/http/agents";
import "../apps/swarm/src/http/approval-requests";
import "../apps/swarm/src/http/budgets";
import "../apps/swarm/src/http/config";
import "../apps/swarm/src/http/context";
import "../apps/swarm/src/http/db-query";
import "../apps/swarm/src/http/ecosystem";

import "../apps/swarm/src/http/api-keys";
import "../apps/swarm/src/http/events";
import "../apps/swarm/src/http/heartbeat";
import "../apps/swarm/src/http/inbox-state";
import "../apps/swarm/src/http/integrations";
import "../apps/swarm/src/http/kv";
import "../apps/swarm/src/http/memory";
import "../apps/swarm/src/http/oauth-locks";
import "../apps/swarm/src/http/page-proxy";
import "../apps/swarm/src/http/pages";
import "../apps/swarm/src/http/pages-public";
import "../apps/swarm/src/http/prompt-templates";
import "../apps/swarm/src/http/poll";
import "../apps/swarm/src/http/pricing";
import "../apps/swarm/src/http/repos";
import "../apps/swarm/src/http/schedules";
import "../apps/swarm/src/http/script-runs";
import "../apps/swarm/src/http/session-data";
import "../apps/swarm/src/http/sessions";
import "../apps/swarm/src/http/skills";
import "../apps/swarm/src/http/scripts";
import "../apps/swarm/src/http/mcp-bridge";
import "../apps/swarm/src/http/mcp-oauth";
import "../apps/swarm/src/http/mcp-servers";
import "../apps/swarm/src/http/stats";
import "../apps/swarm/src/http/status";
import "../apps/swarm/src/http/tasks";
import "../apps/swarm/src/http/task-templates";
import "../apps/swarm/src/http/trackers/jira";
import "../apps/swarm/src/http/trackers/linear";
import "../apps/swarm/src/http/users";
import "../apps/swarm/src/http/webhooks";
import "../apps/swarm/src/http/workflow-events";
import "../apps/swarm/src/http/workflows";
import "../apps/swarm/src/http/x";

const version = (await Bun.file("package.json").json()).version;
const spec = generateOpenApiSpec({ version, serverUrl: "http://localhost:3013" });
await Bun.write("openapi.json", spec);
console.log(`Generated openapi.json (${(spec.length / 1024).toFixed(1)}KB)`);

// Auto-generate docs-site API reference from the new spec
await Bun.$`bun docs-site/scripts/generate-docs.ts`;
