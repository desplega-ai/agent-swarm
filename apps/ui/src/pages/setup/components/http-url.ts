/**
 * The one http(s) URL check of `/setup` (connection, logo, integration and
 * gateway URLs). Returns an error message, or null when the URL is valid.
 * `bare` also rejects a query string and a fragment, like the API validator
 * for base URLs.
 */
export function httpUrlError(value: string, options?: { bare?: boolean }): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const http = url.protocol === "https:" || url.protocol === "http:";
    if (http && (!options?.bare || (!url.search && !url.hash))) return null;
  } catch {
    // Falls through to the messages below.
  }
  return options?.bare
    ? "Use an http or https URL without a query string or fragment."
    : "Start with http:// or https://.";
}
