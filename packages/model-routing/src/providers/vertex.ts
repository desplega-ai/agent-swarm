import { defineRouteProvider } from "../protocols.ts";

/**
 * Google Vertex AI, authenticated through Application Default Credentials.
 * No free key check ships yet, so routes report `configured`.
 */
export const vertexProvider = defineRouteProvider({
  id: "vertex",
  name: "Google Vertex AI",
  protocols: ["vertex"],
  requiredEnv: () => ["CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID"],
});
