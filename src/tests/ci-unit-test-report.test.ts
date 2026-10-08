import { describe, expect, test } from "bun:test";
import { buildPayload, parseJunit } from "../../scripts/ci-unit-test-report";

// Shape emitted by `bun test --reporter=junit` (bun 1.4): one testsuite per file,
// nested testsuites per describe, and attribute values XML-escaped.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="5" failures="1" skipped="2" time="0.3">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="4" failures="1" skipped="1" time="0.2">
    <testsuite name="outer" file="src/a.test.ts" line="3" tests="4" time="0">
      <testsuite name="inner &amp; &quot;nested&quot;" file="src/a.test.ts" line="4" tests="2" time="0">
        <testcase name="slow one" classname="inner" time="0.120" file="src/a.test.ts" line="5" assertions="1" />
        <testcase name="breaks &lt;sometimes&gt;" classname="inner" time="0.004" file="src/a.test.ts" line="6" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;">AssertionError&#10;</failure>
        </testcase>
      </testsuite>
      <testcase name="fast" classname="outer" time="0.000010" file="src/a.test.ts" line="8" assertions="1" />
      <testcase name="later" classname="outer" time="0" file="src/a.test.ts" line="9" assertions="0">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="src/b.test.ts" file="src/b.test.ts" tests="2" failures="0" skipped="1" time="0.1">
    <testcase name="top level" classname="" time="0.06" file="src/b.test.ts" line="2" assertions="2" />
    <testcase name="skipped" classname="" time="0" file="src/b.test.ts" line="3" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

describe("ci-unit-test-report", () => {
  test("parses describe chains, statuses, durations and XML entities", () => {
    expect(parseJunit(JUNIT)).toEqual([
      {
        file: "src/a.test.ts",
        name: 'outer > inner & "nested" > slow one',
        ms: 120,
        status: "pass",
      },
      {
        file: "src/a.test.ts",
        name: 'outer > inner & "nested" > breaks <sometimes>',
        ms: 4,
        status: "fail",
      },
      { file: "src/a.test.ts", name: "outer > fast", ms: 0, status: "pass" },
      { file: "src/a.test.ts", name: "outer > later", ms: 0, status: "skip" },
      { file: "src/b.test.ts", name: "top level", ms: 60, status: "pass" },
      { file: "src/b.test.ts", name: "skipped", ms: 0, status: "skip" },
    ]);
  });

  test("keeps every non-pass and every test at or above minMs, with per-file totals", () => {
    const payload = buildPayload(parseJunit(JUNIT), new Map([["src/a.test.ts", "abc123"]]), 50);
    expect(payload.totals).toEqual({ tests: 6, pass: 3, fail: 1, skip: 2, testMs: 184 });
    expect(payload.files).toEqual([
      ["src/a.test.ts", "abc123", 4, 1, 124],
      ["src/b.test.ts", null, 2, 0, 60],
    ]);
    expect(payload.tests).toEqual([
      [0, 'outer > inner & "nested" > slow one', 120, "p"],
      [0, 'outer > inner & "nested" > breaks <sometimes>', 4, "f"],
      [0, "outer > later", 0, "s"],
      [1, "top level", 60, "p"],
      [1, "skipped", 0, "s"],
    ]);
  });

  test("an empty report parses to no tests", () => {
    expect(
      parseJunit('<?xml version="1.0"?><testsuites name="bun test" tests="0"></testsuites>'),
    ).toEqual([]);
  });
});
