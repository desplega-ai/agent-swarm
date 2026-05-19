/* script-smoke
{
  "name": "scripts-smoke-stringified-args",
  "description": "Smoke test reusable script args passed as a JSON string",
  "intent": "rich scripts api smoke stringified args shape",
  "args": "{\"kind\":\"direct-string\",\"nested\":{\"count\":2}}",
  "expect": {
    "exitCode": 0,
    "result": {
      "receivedType": "string",
      "raw": "{\"kind\":\"direct-string\",\"nested\":{\"count\":2}}",
      "parsed": {
        "kind": "direct-string",
        "nested": {
          "count": 2
        }
      }
    }
  }
}
*/

export default async (args: unknown) => {
  let parsed: unknown = null;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch (error) {
      parsed = { parseError: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    receivedType: Array.isArray(args) ? "array" : typeof args,
    raw: args,
    parsed,
  };
};
