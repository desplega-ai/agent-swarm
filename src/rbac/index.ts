/**
 * Public surface of the RBAC module (DES-445).
 *
 * Import from here at call sites: `import { can } from "@/rbac"`.
 */

export type { AuditSink } from "./can";
export { can, clearAuditSink, setAuditSink } from "./can";
export type { LegacyRule } from "./legacy-policy";
export { LEGACY_POLICY, LEGACY_RULES } from "./legacy-policy";
export type { PermissionVerb } from "./permissions";
export { PERMISSION_VERBS, PERMISSIONS, PermissionVerbSchema } from "./permissions";
export type { RbacCheck, RbacDecision, RbacPrincipal, RbacResource } from "./types";
