/* script-smoke
{
  "name": "scripts-smoke-large-output",
  "description": "Smoke test large stdout, stderr, and result payloads",
  "intent": "rich scripts api smoke large output result",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "resultLength": 262144,
      "resultPrefix": "result-large-start",
      "resultSuffix": "result-large-end"
    },
    "stdoutIncludes": ["stdout-large-start"],
    "stderrIncludes": ["stderr-large-start"],
    "responseIncludes": ["\"truncated\":{\"stdout\":true,\"stderr\":true}"]
  }
}
*/

export default async () => {
  const stdoutBody = "o".repeat(1_100_000);
  const stderrBody = "e".repeat(1_100_000);
  const resultBody = "r".repeat(262_144);

  console.log(`stdout-large-start ${stdoutBody} stdout-large-end`);
  console.error(`stderr-large-start ${stderrBody} stderr-large-end`);

  return {
    resultLength: resultBody.length,
    resultPrefix: "result-large-start",
    resultSuffix: "result-large-end",
    resultBody,
  };
};
