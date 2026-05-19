/* script-smoke
{
  "name": "scripts-smoke-secret-failure-scrub",
  "description": "Smoke test secret scrubbing on stdout and thrown errors",
  "intent": "rich scripts api smoke secret failure scrub",
  "args": {},
  "expect": {
    "exitCode": 1,
    "error": "eval_error",
    "stdoutIncludes": ["stdout-secret [REDACTED:AGENT_SWARM_API_KEY]"],
    "stderrIncludes": ["thrown-secret [REDACTED:AGENT_SWARM_API_KEY]"],
    "responseExcludes": ["__API_KEY__"]
  }
}
*/

export default async (_args: unknown, ctx: any) => {
  const secret = ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);
  console.log("stdout-secret", secret);
  throw new Error(`thrown-secret ${secret}`);
};
