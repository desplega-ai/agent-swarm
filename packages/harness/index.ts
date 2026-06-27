// @swarm/harness — provider factory + adapter contract + the 6 harness adapters
// (claude, claude-managed, codex, devin, opencode, pi), provider credential checks,
// and the claude-bridge launcher. Phase-4: real sources live in ./src; consumers
// import "@swarm/harness". The provider factory (./src/providers/index.ts) lazy-loads
// each adapter via dynamic import() so heavy adapter SDKs stay out of the startup graph.
export * from "./src/claude";
export * from "./src/commands/provider-credentials";
export * from "./src/providers/claude-adapter";
export * from "./src/providers/claude-managed-adapter";
export * from "./src/providers/claude-managed-models";
export * from "./src/providers/claude-managed-pricing";
export * from "./src/providers/claude-managed-swarm-events";
export * from "./src/providers/codex-adapter";
export * from "./src/providers/codex-agents-md";
export * from "./src/providers/codex-models";
export * from "./src/providers/codex-skill-resolver";
export * from "./src/providers/codex-swarm-events";
export * from "./src/providers/ctx-mode-env";
export * from "./src/providers/devin-adapter";
export * from "./src/providers/devin-api";
export * from "./src/providers/devin-playbooks";
export * from "./src/providers/devin-skill-resolver";
export * from "./src/providers/harness-version";
export * from "./src/providers/index";
export * from "./src/providers/opencode-adapter";
export * from "./src/providers/otel-env";
export * from "./src/providers/pi-mono-adapter";
export * from "./src/providers/pi-mono-extension";
export * from "./src/providers/pi-mono-mcp-client";
export * from "./src/providers/swarm-events-shared";
export * as ProvidersTypes from "./src/providers/types";
// ProviderTraits does not collide with any adapter export; expose it flat so cross-package
// (type-only) consumers like @swarm/prompt-templates/base-prompt can import it directly. The
// rest of providers/types stays namespaced via ProvidersTypes to avoid adapter-name clashes.
export type { ProviderTraits } from "./src/providers/types";
export * from "./src/utils/aws-error-classifier";
export * from "./src/utils/mcp-server-fetcher";
