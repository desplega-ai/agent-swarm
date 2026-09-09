import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Summary } from "../../packages/ui-e2e/reporter/ingest-payload.ts";
import {
  buildUploadPlan,
  pickImages,
  type SummaryDirectory,
} from "../../packages/ui-e2e/reporter/publish-plan.ts";

const root = mkdtempSync(join(tmpdir(), "ui-e2e-publish-plan-"));
const firstDirectory = join(root, "all-results/ui-e2e-results-1");
const secondDirectory = join(root, "all-results/ui-e2e-results-2");

function file(directory: string, name: string): string {
  const path = join(directory, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
}

const summaryOne: Summary = {
  shard: { current: 1, total: 2 },
  startedAt: "2026-09-07T10:00:00.000Z",
  finishedAt: "2026-09-07T10:01:00.000Z",
  results: [
    {
      specId: "chromium > specs/smoke.spec.ts > smoke /tasks @smoke",
      titlePath: ["smoke /tasks @smoke"],
      title: "smoke /tasks @smoke",
      file: "specs/smoke.spec.ts",
      status: "passed",
      durationMs: 1,
      retry: 0,
      attachments: [
        {
          name: "screenshot",
          contentType: "image/png",
          path: "/runner/test-results/smoke/auto.png",
        },
        { name: "tasks", contentType: "image/png", path: "/runner/test-results/smoke/tasks.png" },
      ],
    },
    {
      specId: "chromium > specs/failure.spec.ts > fails",
      titlePath: ["fails"],
      title: "fails",
      file: "specs/failure.spec.ts",
      status: "failed",
      durationMs: 1,
      retry: 1,
      attachments: [
        {
          name: "screenshot",
          contentType: "image/png",
          path: join(firstDirectory, "failure/failed.png"),
        },
        {
          name: "trace",
          contentType: "application/zip",
          path: "/runner/test-results/failure/trace.zip",
        },
      ],
    },
    {
      specId: "chromium > specs/missing.spec.ts > missing",
      titlePath: ["missing"],
      title: "missing",
      file: "specs/missing.spec.ts",
      status: "failed",
      durationMs: 1,
      retry: 0,
      attachments: [
        {
          name: "screenshot",
          contentType: "image/png",
          path: "/runner/test-results/missing/nope.png",
        },
      ],
    },
    {
      specId: "chromium > specs/other.spec.ts > keeps the automatic screenshot",
      titlePath: ["keeps the automatic screenshot"],
      title: "keeps the automatic screenshot",
      file: "specs/other.spec.ts",
      status: "passed",
      durationMs: 1,
      retry: 0,
      attachments: [
        {
          name: "screenshot",
          contentType: "image/png",
          path: "/runner/test-results/other/auto.png",
        },
        {
          name: "missing-route",
          contentType: "image/png",
          path: "/runner/test-results/other/nope.png",
        },
      ],
    },
  ],
};

const summaryTwo: Summary = {
  shard: { current: 2, total: 2 },
  startedAt: "2026-09-07T10:00:00.000Z",
  finishedAt: "2026-09-07T10:01:00.000Z",
  results: [],
};

for (const path of [
  "smoke/auto.png",
  "smoke/tasks.png",
  "smoke/retry0.png",
  "failure/failed.png",
  "failure/trace.zip",
  "other/auto.png",
]) {
  file(firstDirectory, path);
}
file(firstDirectory, "summary.json");
file(secondDirectory, "summary.json");

const summaries: SummaryDirectory[] = [
  { dir: firstDirectory, summary: summaryOne },
  { dir: secondDirectory, summary: summaryTwo },
];

test("buildUploadPlan follows the tracker artifact path convention", () => {
  const plan = buildUploadPlan(summaries, "e2e/desplega-ai__agent-swarm/pr-123/abcdef0");

  expect(
    plan.items.every((item) =>
      item.remotePath.startsWith("e2e/desplega-ai__agent-swarm/pr-123/abcdef0/"),
    ),
  ).toBe(true);
  expect(
    plan.items.some((item) => item.remotePath.includes("/1/") && item.kind === "screenshot"),
  ).toBe(true);
  expect(
    plan.items.some((item) => item.kind === "trace" && item.remotePath.endsWith("-trace.zip")),
  ).toBe(true);
  expect(plan.items.filter((item) => item.kind === "log")).toHaveLength(2);
  expect(
    plan.items.some(
      (item) =>
        item.remotePath.endsWith("-screenshot.png") && item.specId?.includes("failure.spec.ts"),
    ),
  ).toBe(true);
  expect(
    plan.items.some(
      (item) =>
        item.remotePath.endsWith("-screenshot.png") && item.specId?.includes("smoke.spec.ts"),
    ),
  ).toBe(false);
  expect(
    plan.items.some(
      (item) =>
        item.remotePath.endsWith("-screenshot.png") && item.specId?.includes("other.spec.ts"),
    ),
  ).toBe(true);
  expect(plan.items.find((item) => item.specId?.includes("failure.spec.ts"))?.localPath).toBe(
    join(firstDirectory, "failure/failed.png"),
  );
  expect(plan.warnings).toEqual([
    "Skipping missing artifact /runner/test-results/missing/nope.png",
    "Skipping missing artifact /runner/test-results/other/nope.png",
  ]);
});

test("pickImages lists failures before smoke route screenshots and limits output", () => {
  const plan = buildUploadPlan(summaries, "e2e/desplega-ai__agent-swarm/pr-123/abcdef0");
  const images = pickImages(plan.items, summaries, 2);

  expect(images).toHaveLength(2);
  expect(images[0]?.name).toBe("failed: fails");
  expect(images[1]?.name).toBe("smoke /tasks @smoke");
});

test("pickImages keeps failed and passed smoke retry attempts in P1 order", () => {
  const retrySummary: Summary = {
    ...summaryOne,
    results: [
      {
        ...summaryOne.results[0]!,
        status: "failed",
        retry: 0,
        attachments: [
          {
            name: "screenshot",
            contentType: "image/png",
            path: "/runner/test-results/smoke/retry0.png",
          },
        ],
      },
      {
        ...summaryOne.results[0]!,
        retry: 1,
        attachments: [
          {
            name: "tasks",
            contentType: "image/png",
            path: "/runner/test-results/smoke/tasks.png",
          },
        ],
      },
    ],
  };
  const retrySummaries = [{ dir: firstDirectory, summary: retrySummary }];
  const plan = buildUploadPlan(retrySummaries, "e2e/desplega-ai__agent-swarm/pr-123/abcdef0");
  const images = pickImages(plan.items, retrySummaries, 24);

  expect(images.map(({ name }) => name)).toEqual([
    "failed: smoke /tasks @smoke",
    "smoke /tasks @smoke",
  ]);
});

test("buildUploadPlan never resolves an attachment outside its shard directory", () => {
  const escaping: Summary = {
    shard: { current: 1, total: 1 },
    startedAt: "2026-09-07T10:00:00.000Z",
    finishedAt: "2026-09-07T10:01:00.000Z",
    results: [
      {
        specId: "chromium > specs/home.spec.ts > home renders",
        titlePath: ["home renders"],
        title: "home renders",
        file: "specs/home.spec.ts",
        status: "passed",
        durationMs: 10,
        retry: 0,
        attachments: [
          {
            name: "screenshot",
            contentType: "image/png",
            path: "/runner/test-results/../../../../etc/hosts",
          },
        ],
      },
    ],
  };
  const plan = buildUploadPlan([{ dir: firstDirectory, summary: escaping }], "e2e/x/main/abcdef0");
  expect(plan.items.filter((item) => item.kind !== "log")).toEqual([]);
  expect(plan.warnings).toEqual([
    "Skipping missing artifact /runner/test-results/../../../../etc/hosts",
  ]);
});
