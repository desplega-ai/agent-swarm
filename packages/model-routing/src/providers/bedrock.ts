import { defineRouteProvider } from "../protocols.ts";
import { secretEnv } from "./secret-env.ts";

/**
 * Amazon Bedrock. Auth is `AWS_BEARER_TOKEN_BEDROCK` or the AWS credential
 * chain. Claude Code reads the region only from `AWS_REGION`. No free key check
 * ships yet, so routes report `configured`.
 */
export const bedrockProvider = defineRouteProvider({
  id: "bedrock",
  name: "Amazon Bedrock",
  protocols: ["bedrock"],
  requiredEnv: (route) => ["AWS_REGION", ...secretEnv(route)],
});
