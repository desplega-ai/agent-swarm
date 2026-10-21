/**
 * Input caps shared by both MCP surfaces (`/mcp` and `/mcp-user`).
 *
 * The SDK leaves both bounds off when you build the server yourself
 * (GHSA-46jr-4wx8-v453): `McpServer` only counts `tools/call` arguments when
 * `maxToolInputElements` is set, and our HTTP handlers read the request body
 * themselves, so the transport's own body cap never runs.
 */

/**
 * Largest combined number of array elements and object members a single
 * `tools/call` `arguments` payload may contain. Sized for the largest
 * legitimate call: `app-rows-create` takes up to 500 rows, which is about
 * 24,000 elements at 48 fields per row. Script SDK calls go through
 * `/api/mcp-bridge`, which does not apply it.
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 25_000;

/** Largest MCP HTTP request body we read, in bytes. Matches the SDK default (4 MiB). */
export const MCP_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
