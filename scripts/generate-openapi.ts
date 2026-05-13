import { generateOpenApiSpec } from "../src/http/openapi";
// Import all handler files to trigger route() registrations
import "../src/http/active-sessions";
import "../src/http/agents";
import "../src/http/approval-requests";
import "../src/http/budgets";
import "../src/http/config";
import "../src/http/context";
import "../src/http/db-query";
import "../src/http/ecosystem";

import "../src/http/api-keys";
import "../src/http/events";
import "../src/http/heartbeat";
import "../src/http/inbox-state";
import "../src/http/integrations";
import "../src/http/memory";
import "../src/http/page-proxy";
import "../src/http/pages";
import "../src/http/pages-public";
import "../src/http/prompt-templates";
import "../src/http/poll";
import "../src/http/pricing";
import "../src/http/repos";
import "../src/http/schedules";
import "../src/http/session-data";
import "../src/http/sessions";
import "../src/http/skills";
import "../src/http/mcp-oauth";
import "../src/http/mcp-servers";
import "../src/http/stats";
import "../src/http/status";
import "../src/http/tasks";
import "../src/http/task-templates";
import "../src/http/trackers/jira";
import "../src/http/trackers/linear";
import "../src/http/users";
import "../src/http/webhooks";
import "../src/http/workflow-events";
import "../src/http/workflows";

const version = (await Bun.file("package.json").json()).version;
const spec = generateOpenApiSpec({ version, serverUrl: "http://localhost:3013" });
await Bun.write("openapi.json", spec);
console.log(`Generated openapi.json (${(spec.length / 1024).toFixed(1)}KB)`);

// Auto-generate docs-site API reference from the new spec
await Bun.$`bun docs-site/scripts/generate-docs.ts`;
