/* script-smoke
{
  "name": "scripts-smoke-redacted-abuse",
  "description": "Probe Redacted wrapper behavior for common accidental-leak paths",
  "intent": "rich scripts api smoke redacted abuse",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "keys": [],
      "spreadKeys": [],
      "stringValue": "<redacted>",
      "templateValue": "token=<redacted>",
      "jsonValue": "\"<redacted>\"",
      "inspectValue": "<redacted>",
      "structuredCloneKeys": [],
      "allViewsAvoidRawSecret": true
    },
    "stdoutIncludes": ["redacted-template token=<redacted>"],
    "responseExcludes": ["__API_KEY__"]
  }
}
*/

export default async (_args: unknown, ctx: any) => {
  const secret = ctx.swarm.config.apiKey;
  const raw = ctx.stdlib.Redacted.value(secret);
  const inspect = (globalThis as any).Bun?.inspect ?? ((value: unknown) => String(value));
  const clone = structuredClone(secret);
  const spread = { ...secret };
  const views = [
    String(secret),
    `token=${secret}`,
    JSON.stringify(secret),
    inspect(secret),
    JSON.stringify(Object.keys(secret)),
    JSON.stringify(spread),
    JSON.stringify(clone),
    inspect(clone),
  ];

  console.log("redacted-template", `token=${secret}`);

  return {
    keys: Object.keys(secret),
    spreadKeys: Object.keys(spread),
    stringValue: String(secret),
    templateValue: `token=${secret}`,
    jsonValue: JSON.stringify(secret),
    inspectValue: inspect(secret),
    structuredCloneKeys: Object.keys(clone),
    structuredCloneJson: JSON.stringify(clone),
    allViewsAvoidRawSecret: views.every((value) => !value.includes(raw)),
  };
};
