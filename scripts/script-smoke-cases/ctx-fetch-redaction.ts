/* script-smoke
{
  "name": "scripts-smoke-ctx-fetch-redaction",
  "description": "Smoke test ctx config redaction and async fetch",
  "intent": "rich scripts api smoke ctx fetch redaction",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "healthOk": true,
      "apiKeyString": "<redacted>",
      "apiKeyJson": "\"<redacted>\"",
      "apiKeySecret": true,
      "mcpBaseUrlSecret": false
    },
    "stdoutIncludes": ["stdout-wrapped-api-key <redacted>"],
    "responseExcludes": ["__API_KEY__"]
  }
}
*/

export default async (_args: unknown, ctx: any) => {
  const { Redacted } = ctx.stdlib;
  const health = await ctx.stdlib.fetch(`${Redacted.value(ctx.swarm.config.mcpBaseUrl)}/health`, {
    retries: 1,
    timeoutMs: 5000,
  });

  console.log("stdout-wrapped-api-key", String(ctx.swarm.config.apiKey));

  return {
    healthOk: health.status === "ok",
    apiKeyString: String(ctx.swarm.config.apiKey),
    apiKeyJson: JSON.stringify(ctx.swarm.config.apiKey),
    apiKeySecret: Redacted.isSecret(ctx.swarm.config.apiKey),
    mcpBaseUrlSecret: Redacted.isSecret(ctx.swarm.config.mcpBaseUrl),
  };
};
