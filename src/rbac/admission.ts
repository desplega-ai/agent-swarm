import type { PermissionVerb } from "./permissions";

export type AdmissionGrant = {
  grantsAll: boolean;
  verbs: {
    has(verb: PermissionVerb): boolean;
  };
};

export type AdmissionRbac = { permission: PermissionVerb } | { ungated: string };

export type AdmissionDecision =
  | { allow: true; verb?: PermissionVerb }
  | { allow: false; reason: string; verb?: PermissionVerb };

export function isRbacEnabled(): boolean {
  return process.env.RBAC_ENABLED === "true";
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
    const verb = input.rbac.permission;
    if (input.grant.verbs.has(verb)) {
      return { allow: true, verb };
    }
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
    const verb = input.rbac.permission;
    if (input.grant.verbs.has(verb)) {
      return { allow: true, verb };
    }
    return { allow: false, reason: `admission: missing permission '${verb}'`, verb };
  }

  if (input.readOnly) {
    return { allow: true };
  }

  return { allow: false, reason: "admission: tool has no permission verb (operator-only)" };
}
