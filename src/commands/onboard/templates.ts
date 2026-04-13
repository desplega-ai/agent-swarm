import type { TemplateConfig } from "../../../templates/schema.ts";

const DEFAULT_REGISTRY_URL = "https://templates.agent-swarm.dev";

export async function fetchTemplateList(
  registryUrl: string = DEFAULT_REGISTRY_URL,
): Promise<TemplateConfig[]> {
  const url = `${registryUrl.replace(/\/+$/, "")}/api/templates`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to reach template registry at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new Error(`Template registry returned HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as { templates?: TemplateConfig[] } | TemplateConfig[];

  // The API may return { templates: [...] } or a raw array
  if (Array.isArray(data)) {
    return data;
  }
  if (data.templates && Array.isArray(data.templates)) {
    return data.templates;
  }

  throw new Error("Unexpected response format from template registry");
}
