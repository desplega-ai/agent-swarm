/**
 * Route contract shared by the server, the worker, and the UI (issue #1800).
 *
 * A route says where a harness's model traffic goes: endpoint, wire protocol,
 * auth. Providers (pi-ai's `provider`) describe a vendor or gateway family;
 * one provider serves many routes.
 *
 * Pure module: no IO, no Bun APIs.
 */

/** Resolved worker env. Values are secrets: never log them. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Harnesses whose traffic can be routed. devin / claude-managed / acp: default route only. */
export type RoutableHarness = "claude" | "codex" | "pi" | "opencode" | "dsh";

/** Wire protocol (pi-ai's `api`). Closed: every renderer handles each value. */
export type Protocol =
  | "anthropic-messages" // Claude Code, pi, opencode
  | "openai-responses" // Codex (only option), pi, opencode
  | "openai-chat" // pi, opencode, dsh
  | "bedrock"
  | "vertex"
  | "foundry"; // cloud-native, Claude Code (pi: bedrock)

/** Secrets are env / swarm_config KEY NAMES, never values. */
export type RouteAuth =
  | { kind: "bearer"; secretKey: string }
  | { kind: "x-api-key"; secretKey: string }
  | { kind: "header"; header: string; secretKey: string } // cf-aig-authorization, x-portkey-api-key
  | { kind: "cloud-chain" } // AWS chain / Entra ID / GCP ADC
  | { kind: "subscription"; plan: "claude" | "codex" }; // OAuth pools

/** Where traffic goes: a stored route, or the env-derived default. */
export interface ModelRoute {
  /** uuid, or "default:<harness>". */
  id: string;
  name: string;
  source: "custom" | "default";
  /** RouteProvider.id */
  provider: string;
  protocol: Protocol;
  baseUrl?: string;
  auth: RouteAuth;
  /** Non-secret only. */
  headers?: Record<string, string>;
  cloud?: { region?: string; resource?: string; project?: string };
  /** claude: ANTHROPIC_DEFAULT_HAIKU_MODEL for background calls. */
  smallModel?: string;
}

export interface RouteModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

/** fetch that refuses any origin other than route.baseUrl's. */
export type ScopedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface RouteContext {
  route: ModelRoute;
  /** Resolved worker env; never logged. */
  env: Env;
  fetch: ScopedFetch;
  signal: AbortSignal;
}

export type RouteValidation =
  | { status: "verified"; models?: string[] }
  | { status: "configured"; reason: string }
  | { status: "failed"; reason: string; missing?: string[] };

/** Vendor or gateway family (pi-ai's `provider`). One definition, many routes. */
export interface RouteProvider {
  /** "anthropic" | "anthropic-gateway" | "foundry" | ... */
  id: string;
  name: string;
  protocols: readonly Protocol[];
  /** Harnesses allowed to use this provider. Absent → any harness that speaks a protocol. */
  harnesses?: readonly RoutableHarness[];
  defaultBaseUrl?: string;
  /** Prefills a new profile's model; used by default routes for legacy agents. */
  defaultModel?: string;
  /** Env key names the presence gate requires. */
  requiredEnv(route: ModelRoute): string[];
  /**
   * True when the harness speaks this protocol natively, so the renderer only
   * swaps endpoint + auth instead of writing a provider block.
   */
  isHarnessDefaultProtocol(harness: RoutableHarness, protocol: Protocol): boolean;
  /** Live model list (pi-ai's fetchModels). Absent → static model-catalog list. */
  modelList?(ctx: RouteContext): Promise<RouteModel[]>;
  /** Free credential check. Absent → "configured" when requiredEnv is present. */
  validate?(ctx: RouteContext): Promise<RouteValidation>;
}

export interface RouteCredentialStatus {
  ready: boolean;
  missing: string[];
  hint: string;
}
