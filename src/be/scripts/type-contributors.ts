/**
 * Context available to dynamic script type contributors. It is deliberately
 * small today; `agentId` is the future hook for filtering app types by
 * `app.use` once per-app RBAC policy exists.
 */
export interface ScriptTypeContext {
  agentId?: string;
  repoId?: string;
}

/**
 * A script type contributor returns a `.d.ts` fragment that is valid both as
 * a module body and inside `declare module "swarm-sdk" { ... }`. It declares
 * only names it owns (prefix-namespaced) or merges into `SwarmSdk`, returns ""
 * when it has nothing to contribute, and never throws.
 *
 * Implementations: `getScriptApiTypes` / `getScriptMcpTypes`
 * (`src/be/script-connections.ts`) and `getScriptAppTypes`
 * (`src/apps/script-types.ts`). Adding a fourth (e.g. typed workflows, if
 * `swarm-script` nodes ever get a typecheck gate) is one parameter on
 * `scriptSdkTypesWithGeneratedApis` / `scriptStdlibTypesWithGeneratedApis` —
 * never a compiler-host or files-Map change.
 */
export type ScriptTypeContributor = (context: ScriptTypeContext) => string;
