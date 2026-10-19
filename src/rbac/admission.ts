import { isEnvFlagEnabled } from "../utils/env-flag";
import type { PermissionVerb } from "./permissions";

export type AdmissionGrant = {
  grantsAll: boolean;
  verbs: {
    has(verb: PermissionVerb): boolean;
  };
};

/**
 * `alsoAdmits` names verbs that admit the route as well as `permission`, for a
 * route that serves two features (each handler check still names its own verb).
 */
export type AdmissionRbac =
  | { permission: PermissionVerb; alsoAdmits?: readonly PermissionVerb[] }
  | { ungated: string };

function grantedVerb(
  rbac: { permission: PermissionVerb; alsoAdmits?: readonly PermissionVerb[] },
  grant: AdmissionGrant,
): PermissionVerb | undefined {
  return [rbac.permission, ...(rbac.alsoAdmits ?? [])].find((verb) => grant.verbs.has(verb));
}

export type AdmissionDecision =
  | { allow: true; verb?: PermissionVerb }
  | { allow: false; reason: string; verb?: PermissionVerb };

export function isRbacEnabled(): boolean {
  return isEnvFlagEnabled("RBAC_ENABLED", true);
}

export function decideAdmission(input: {
  method: string;
  rbac: AdmissionRbac | undefined;
  routeKnown: boolean;
  grant: AdmissionGrant;
}): AdmissionDecision {
  if (input.grant.grantsAll) {
    return { allow: true };
  }

  if (input.rbac && "permission" in input.rbac) {
    const granted = grantedVerb(input.rbac, input.grant);
    if (granted) {
      return { allow: true, verb: granted };
    }
    const verb = input.rbac.permission;
    return { allow: false, reason: `admission: missing permission '${verb}'`, verb };
  }

  const method = input.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { allow: true };
  }

  return { allow: false, reason: "admission: route has no permission verb (operator-only)" };
}

export function decideToolAdmission(input: {
  rbac: AdmissionRbac | undefined;
  readOnly: boolean;
  grant: AdmissionGrant;
}): AdmissionDecision {
  if (input.grant.grantsAll) {
    return { allow: true };
  }

  if (input.rbac && "permission" in input.rbac) {
    const granted = grantedVerb(input.rbac, input.grant);
    if (granted) {
      return { allow: true, verb: granted };
    }
    const verb = input.rbac.permission;
    return { allow: false, reason: `admission: missing permission '${verb}'`, verb };
  }

  if (input.readOnly) {
    return { allow: true };
  }

  return { allow: false, reason: "admission: tool has no permission verb (operator-only)" };
}
