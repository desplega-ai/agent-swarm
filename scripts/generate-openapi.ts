import { generateOpenApiSpec } from "../src/http/openapi";
// Import all handler files to trigger route() registrations — the list lives
// in src/http/all-routes.ts (shared with scripts/check-rbac-coverage.ts).
import "../src/http/all-routes";

const version = (await Bun.file("package.json").json()).version;
const spec = generateOpenApiSpec({ version, serverUrl: "http://localhost:3013" });
await Bun.write("openapi.json", spec);
console.log(`Generated openapi.json (${(spec.length / 1024).toFixed(1)}KB)`);

// Auto-generate docs-site API reference from the new spec
await Bun.$`bun docs-site/scripts/generate-docs.ts`;

// Regenerate the SDK's types (a filtered subset of the spec).
await Bun.$`bun packages/agent-swarm-sdk/scripts/gen-types.ts`;
