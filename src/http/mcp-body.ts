import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/mcp-limits";
import { parseBody, RequestBodyTooLargeError } from "./utils";

/** Returned by `readMcpBody` after it has answered the request with 413. */
export const MCP_BODY_TOO_LARGE = Symbol("mcp-body-too-large");

/**
 * Read and parse a JSON-RPC request body for an MCP HTTP handler, capped at
 * `MCP_MAX_REQUEST_BODY_BYTES`. A declared Content-Length over the cap is
 * refused before reading; otherwise the read stops once the cap is crossed.
 * Either way the caller gets `MCP_BODY_TOO_LARGE` after a 413 with a JSON-RPC
 * error body (the SDK transport's shape), and the body never reaches
 * `JSON.parse`.
 */
export async function readMcpBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof MCP_BODY_TOO_LARGE> {
  try {
    return await parseBody(req, MCP_MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Payload Too Large: Request body must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes`,
        },
        id: null,
      }),
    );
    return MCP_BODY_TOO_LARGE;
  }
}
