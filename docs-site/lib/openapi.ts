import { createOpenAPI } from "fumadocs-openapi/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Creates the OpenAPI server instance.
 *
 * Server URL can be overridden via NEXT_PUBLIC_API_SERVER_URL env var.
 * If not set, uses the URL from the OpenAPI spec's servers array.
 */
export const openapi = createOpenAPI({
  input: () => {
    const specPath = resolve(process.cwd(), "../openapi.json");
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));

    const serverUrl = process.env.NEXT_PUBLIC_API_SERVER_URL;
    if (serverUrl) {
      spec.servers = [{ url: serverUrl, description: "API Server" }];
    }

    return { "../openapi.json": spec };
  },
});
