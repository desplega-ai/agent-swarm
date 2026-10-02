// Azure / Microsoft Foundry embeddings: the URL rules of the memory presets.

/** Azure serves its OpenAI-compatible v1 API under this path. */
const AZURE_V1_PATH = "/openai/v1";
const AZURE_HOST_SUFFIXES = [
  ".services.ai.azure.com",
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
];

/**
 * A Foundry resource name (`my-resource`) or any URL of the resource becomes
 * its `/openai/v1` base URL. Anything else passes through for `baseUrlError`.
 */
export function azureBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    return `https://${value}.services.ai.azure.com${AZURE_V1_PATH}`;
  }
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.origin}${AZURE_V1_PATH}`;
  } catch {
    return value;
  }
}

/**
 * The hint for an Azure host whose path lacks `/openai/v1`. A hint, never a
 * rewrite: a proxy can sit on an Azure-looking host.
 */
export function azurePathHint(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  if (url.pathname.replace(/\/+$/, "").endsWith(AZURE_V1_PATH)) return null;
  return `Azure endpoints need the ${AZURE_V1_PATH} path: ${url.origin}${AZURE_V1_PATH}`;
}
