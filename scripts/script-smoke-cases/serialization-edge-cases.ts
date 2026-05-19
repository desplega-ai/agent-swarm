/* script-smoke
{
  "name": "scripts-smoke-serialization-edge-cases",
  "description": "Smoke test result serialization edge cases",
  "intent": "rich scripts api smoke serialization edge cases",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "undefinedTopLevelSerializesToNull": true,
      "nullValue": null,
      "dateValue": "2026-05-19T12:34:56.789Z",
      "bigIntThrows": true,
      "circularThrows": true,
      "mapValue": {},
      "setValue": {},
      "classValue": {
        "kind": "example",
        "count": 3
      }
    }
  }
}
*/

class ExampleResult {
  kind = "example";
  count = 3;

  hidden() {
    return "method";
  }
}

function jsonStringifyThrows(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return false;
  } catch {
    return true;
  }
}

export default async () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const absent: unknown = undefined;

  return {
    undefinedTopLevelSerializesToNull: JSON.stringify(absent ?? null) === "null",
    nullValue: null,
    dateValue: new Date("2026-05-19T12:34:56.789Z"),
    bigIntThrows: jsonStringifyThrows(1n),
    circularThrows: jsonStringifyThrows(circular),
    mapValue: new Map([["a", 1]]),
    setValue: new Set(["a", "b"]),
    classValue: new ExampleResult(),
  };
};
