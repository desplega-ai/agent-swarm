import { z } from "zod";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { proxySwarmApi } from "./script-common";
import { type RequestInfo, swarmToolOutputSchema, toolErr, toolOk } from "./utils";

export const runtimePoolToolOutputSchema = swarmToolOutputSchema({
  pool: z.looseObject({}).optional(),
  pools: z.array(z.looseObject({})).optional(),
  agent: z.looseObject({}).optional(),
  controllers: z.array(z.looseObject({})).optional(),
  deleted: z.boolean().optional(),
});

export async function proxyRuntimePoolsApi(args: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  requestInfo: RequestInfo;
  message: string;
}) {
  if (!isRuntimePoolsEnabled()) return toolErr("runtime pools are disabled");
  return proxySwarmApi({
    ...args,
    transportError:
      "Runtime pool tools require HTTP MCP transport with agent identity. Use the HTTP API for operator requests.",
    respond: (data, response) => {
      const payload = data as Record<string, unknown> | undefined;
      if (!response.ok)
        return toolErr(
          typeof payload?.error === "string"
            ? payload.error
            : `Runtime pools API returned HTTP ${response.status}`,
        );
      return toolOk(args.message, { data: payload });
    },
  });
}
