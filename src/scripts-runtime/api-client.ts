import type {
  ScriptApiConnectionDescriptor,
  ScriptApiOperationDescriptor,
  ScriptApiRegistryClient,
} from "./api-types";

function applyTemplate(template: string, _placeholder: string): [string, string] | null {
  const idx = template.indexOf("=");
  if (idx >= 0) return [template.slice(0, idx), template.slice(idx + 1)];
  const colon = template.indexOf(":");
  if (colon >= 0) return [template.slice(0, colon).trim(), template.slice(colon + 1).trim()];
  return null;
}

function operationUrl(
  baseUrl: string,
  operation: ScriptApiOperationDescriptor,
  args: Record<string, unknown>,
) {
  const pathArgs = (args.path && typeof args.path === "object" ? args.path : {}) as Record<
    string,
    unknown
  >;
  let path = operation.path;
  for (const param of operation.parameters.filter((p) => p.in === "path")) {
    const value = pathArgs[param.name];
    if (value === undefined && param.required)
      throw new Error(`Missing path parameter ${param.name}`);
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(value ?? "")));
  }
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const queryArgs = (args.query && typeof args.query === "object" ? args.query : {}) as Record<
    string,
    unknown
  >;
  for (const param of operation.parameters.filter((p) => p.in === "query")) {
    const value = queryArgs[param.name];
    if (value === undefined) {
      if (param.required) throw new Error(`Missing query parameter ${param.name}`);
      continue;
    }
    url.searchParams.set(param.name, String(value));
  }
  return url;
}

export function createApiRegistryClient(
  descriptors: ScriptApiConnectionDescriptor[] = [],
): ScriptApiRegistryClient {
  const registry: ScriptApiRegistryClient = {};
  for (const descriptor of descriptors) {
    const client: ScriptApiRegistryClient[string] = {};
    for (const operation of descriptor.operations) {
      client[operation.name] = async (rawArgs = {}) => {
        const args = rawArgs as Record<string, unknown>;
        const url = operationUrl(descriptor.baseUrl, operation, args);
        const headers = new Headers();
        const headerArgs = (
          args.header && typeof args.header === "object" ? args.header : {}
        ) as Record<string, unknown>;
        for (const param of operation.parameters.filter((p) => p.in === "header")) {
          const value = headerArgs[param.name];
          if (value === undefined) {
            if (param.required) throw new Error(`Missing header parameter ${param.name}`);
            continue;
          }
          headers.set(param.name, String(value));
        }

        const placeholder = descriptor.credential
          ? `[REDACTED:${descriptor.credential.configKey}]`
          : null;
        if (placeholder && descriptor.credential?.headerTemplate) {
          const parsed = applyTemplate(descriptor.credential.headerTemplate, placeholder);
          if (parsed) headers.set(parsed[0], parsed[1]);
        }
        if (placeholder && descriptor.credential?.queryTemplate) {
          const parsed = applyTemplate(descriptor.credential.queryTemplate, placeholder);
          if (parsed) url.searchParams.set(parsed[0], parsed[1]);
        }

        const init: RequestInit = { method: operation.method, headers };
        if (operation.hasBody) {
          headers.set("content-type", headers.get("content-type") ?? "application/json");
          init.body = JSON.stringify(args.body ?? null);
        }
        const response = await fetch(url, init);
        if (!response.ok) {
          throw new Error(
            `ctx.api.${descriptor.slug}.${operation.name} failed with ${response.status}`,
          );
        }
        const contentType = response.headers.get("content-type") ?? "";
        return contentType.includes("application/json") ? response.json() : response.text();
      };
    }
    registry[descriptor.slug] = client;
  }
  return registry;
}
