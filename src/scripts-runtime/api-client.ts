import type {
  ScriptApiConnectionDescriptor,
  ScriptApiCredentialDescriptor,
  ScriptApiOperationDescriptor,
  ScriptApiRegistryClient,
} from "./api-types";

function applyTemplate(template: string): [string, string] | null {
  const idx = template.indexOf("=");
  if (idx >= 0) return [template.slice(0, idx), template.slice(idx + 1)];
  const colon = template.indexOf(":");
  if (colon >= 0) return [template.slice(0, colon).trim(), template.slice(colon + 1).trim()];
  return null;
}

function applyCredential(
  credential: ScriptApiCredentialDescriptor | null,
  url: URL,
  headers: Headers,
) {
  if (!credential) return;
  if (credential.headerTemplate) {
    const parsed = applyTemplate(credential.headerTemplate);
    if (parsed) headers.set(parsed[0], parsed[1]);
  }
  if (credential.queryTemplate) {
    const parsed = applyTemplate(credential.queryTemplate);
    if (parsed) url.searchParams.set(parsed[0], parsed[1]);
  }
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
  // Spec paths are absolute ("/store/inventory"); resolve them relative to the
  // base URL so a base path prefix like "/api/v3" is preserved.
  const url = new URL(path.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
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

function graphqlErrorMessage(errors: unknown): string {
  if (!Array.isArray(errors)) return JSON.stringify(errors);
  return errors
    .map((error) => {
      if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
      }
      return JSON.stringify(error);
    })
    .join("; ");
}

export function createApiRegistryClient(
  descriptors: ScriptApiConnectionDescriptor[] = [],
): ScriptApiRegistryClient {
  const registry: ScriptApiRegistryClient = {};
  for (const descriptor of descriptors) {
    const client: ScriptApiRegistryClient[string] = {};
    if (descriptor.kind === "graphql") {
      client.graphql = async (query, variables) => {
        if (typeof query !== "string") {
          throw new Error(`ctx.api.${descriptor.slug}.graphql query must be a string`);
        }
        const url = new URL(descriptor.baseUrl);
        const headers = new Headers({ "content-type": "application/json" });
        applyCredential(descriptor.credential, url, headers);
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
        });
        if (!response.ok) {
          throw new Error(`ctx.api.${descriptor.slug}.graphql failed with ${response.status}`);
        }
        const body = (await response.json()) as unknown;
        if (body && typeof body === "object") {
          const record = body as { data?: unknown; errors?: unknown };
          if (Array.isArray(record.errors) && !("data" in record)) {
            throw new Error(
              `ctx.api.${descriptor.slug}.graphql failed: ${graphqlErrorMessage(record.errors)}`,
            );
          }
          if ("data" in record) return record.data;
        }
        return body;
      };
      registry[descriptor.slug] = client;
      continue;
    }

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

        applyCredential(descriptor.credential, url, headers);

        const init: RequestInit = { method: operation.method, headers };
        // Guard against stored runtimes generated before hasBody excluded
        // GET/HEAD — fetch() throws on GET/HEAD requests with a body.
        const methodAllowsBody = !["GET", "HEAD"].includes(operation.method.toUpperCase());
        if (operation.hasBody && methodAllowsBody) {
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
