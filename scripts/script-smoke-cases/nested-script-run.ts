/* script-smoke
{
  "name": "scripts-smoke-nested-script-run",
  "description": "Smoke test reusable script calling another reusable script via ctx.swarm.script_run",
  "intent": "rich scripts api smoke nested script_run args shapes",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "objectCall": {
        "success": true,
        "status": 200,
        "data": {
          "exitCode": 0,
          "result": {
            "receivedType": "object",
            "raw": {
              "kind": "nested-object",
              "nested": {
                "count": 1
              }
            }
          }
        }
      },
      "stringCall": {
        "success": true,
        "status": 200,
        "data": {
          "exitCode": 0,
          "result": {
            "receivedType": "object",
            "raw": {
              "kind": "nested-string",
              "nested": {
                "count": 3
              }
            },
            "parsed": null
          }
        }
      }
    }
  }
}
*/

export default async (_args: unknown, ctx: any) => {
  const objectCall = await ctx.swarm.script_run({
    name: "scripts-smoke-stringified-args",
    scope: "agent",
    intent: "nested smoke object args",
    args: {
      kind: "nested-object",
      nested: {
        count: 1,
      },
    },
  });

  const stringCall = await ctx.swarm.script_run({
    name: "scripts-smoke-stringified-args",
    scope: "agent",
    intent: "nested smoke string args",
    args: JSON.stringify({
      kind: "nested-string",
      nested: {
        count: 3,
      },
    }),
  });

  return { objectCall, stringCall };
};
