import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/mcp-limits";
import { parseBody, RequestBodyParseError, RequestBodyTooLargeError } from "./utils";

/** Returned by `readMcpBody` after it has answered the request with 413 or 400. */
export const MCP_BODY_ANSWERED = Symbol("mcp-body-answered");

/**
 * Read and parse a JSON-RPC request body for an MCP HTTP handler, capped at
 * `MCP_MAX_REQUEST_BODY_BYTES`. A declared Content-Length over the cap is
 * refused before reading; otherwise the read stops once the cap is crossed.
 * Either way the caller gets `MCP_BODY_ANSWERED` after a 413 with a JSON-RPC
 * error body (the SDK transport's shape), and the body never reaches
 * `JSON.parse`. A body that is not valid JSON gets 400 with the JSON-RPC parse
 * error (-32700), also the SDK transport's shape.
 */
export async function readMcpBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof MCP_BODY_ANSWERED> {
  try {
    return await parseBody(req, MCP_MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyParseError) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
          id: null,
        }),
      );
      return MCP_BODY_ANSWERED;
    }
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
    return MCP_BODY_ANSWERED;
  }
}
