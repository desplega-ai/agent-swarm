import { describe, expect, test } from "bun:test";
import { TriggerConfigSchema } from "../types";
import {
  decideWebhookDelivery,
  WEBHOOK_EVENT_HEADER_INVALID_MESSAGE,
  WEBHOOK_EVENTS_INVALID_MESSAGE,
  WEBHOOK_FILTER_INVALID_MESSAGE,
  WEBHOOK_PRESET_INVALID_MESSAGE,
  type WebhookDeliverySkip,
  type WebhookHeaderBag,
} from "../workflows/webhook-filter";

const githubPullRequest = {
  headers: { "x-github-event": ["pull_request"] },
  body: { action: ["opened", "reopened", "ready_for_review", "synchronize"] },
};

function allow(
  trigger: Parameters<typeof decideWebhookDelivery>[0],
  headers: WebhookHeaderBag = {},
  body: unknown = {},
): void {
  expect(decideWebhookDelivery(trigger, headers, body)).toEqual({ action: "allow" });
}

function skip(
  trigger: Parameters<typeof decideWebhookDelivery>[0],
  headers: WebhookHeaderBag = {},
  body: unknown = {},
): WebhookDeliverySkip {
  const decision = decideWebhookDelivery(trigger, headers, body);
  expect(decision.action).toBe("skip");
  if (decision.action !== "skip") throw new Error("expected a skip");
  return decision.skip;
}

function miss(
  trigger: Parameters<typeof decideWebhookDelivery>[0],
  headers: WebhookHeaderBag = {},
  body: unknown = {},
): { source: "header" | "body"; path: string } {
  const dropped = skip(trigger, headers, body);
  if (dropped.reason !== "filter-not-matched") {
    throw new Error(`expected filter-not-matched, got ${dropped.reason}`);
  }
  return dropped.match;
}

describe("webhook delivery filter", () => {
  test("matches a GitHub pull request action on the header and the body", () => {
    const trigger = { filter: githubPullRequest };
    const headers = { "X-GitHub-Event": "pull_request" };
    allow(trigger, headers, { action: "opened" });
    allow(trigger, headers, { action: "ready_for_review" });
    expect(skip(trigger, headers, { action: "closed" })).toEqual({
      skipped: true,
      reason: "filter-not-matched",
      match: { source: "body", path: "action" },
    });
    expect(skip(trigger, { "x-github-event": "push" }, { action: "opened" })).toEqual({
      skipped: true,
      reason: "filter-not-matched",
      match: { source: "header", path: "x-github-event" },
    });
  });

  test("header names are case-insensitive and values are exact", () => {
    const trigger = { filter: { headers: { "X-GitHub-Event": "pull_request" } } };
    allow(trigger, { "x-github-event": "pull_request" });
    expect(miss(trigger, { "x-github-event": "Pull_Request" })).toEqual({
      source: "header",
      path: "X-GitHub-Event",
    });
  });

  test("a repeated header uses the first value", () => {
    const trigger = { filter: { headers: { "X-GitHub-Event": ["pull_request"] } } };
    expect(miss(trigger, { "X-GitHub-Event": ["push", "pull_request"] })).toEqual({
      source: "header",
      path: "X-GitHub-Event",
    });
  });

  test("a body-only filter does not require the GitHub event header", () => {
    allow({ filter: { body: { action: "opened" } } }, {}, { action: "opened" });
    expect(miss({ filter: { body: { action: "opened" } } }, {}, { action: "closed" })).toEqual({
      source: "body",
      path: "action",
    });
  });

  test("body scalars match exactly, including false, null, and numbers", () => {
    const trigger = {
      filter: {
        body: {
          "pull_request.draft": false,
          "pull_request.number": 42,
          "pull_request.milestone": null,
        },
      },
    };
    allow(trigger, {}, { pull_request: { draft: false, number: 42, milestone: null } });
    expect(
      miss(trigger, {}, { pull_request: { draft: false, number: "42", milestone: null } }),
    ).toEqual({ source: "body", path: "pull_request.number" });
    expect(
      miss(trigger, {}, { pull_request: { draft: true, number: 42, milestone: null } }),
    ).toEqual({ source: "body", path: "pull_request.draft" });
  });

  test("array indexes use a canonical decimal segment and ignore inherited keys", () => {
    const body = { commits: [{ id: "abc" }, { id: "def" }] };
    allow({ filter: { body: { "commits.0.id": "abc" } } }, {}, body);
    expect(miss({ filter: { body: { "commits.1.id": "abc" } } }, {}, body).path).toBe(
      "commits.1.id",
    );
    expect(miss({ filter: { body: { "commits.01.id": "def" } } }, {}, body).path).toBe(
      "commits.01.id",
    );
    expect(miss({ filter: { body: { toString: "function" } } }, {}, {}).path).toBe("toString");
    expect(miss({ filter: { body: { "constructor.name": "Object" } } }, {}, {}).path).toBe(
      "constructor.name",
    );
  });

  test("a missing body field or a non-JSON body misses without echoing the value", () => {
    const dropped = skip(
      { filter: { headers: { Authorization: ["Bearer expected"] }, body: { token: "expected" } } },
      { authorization: "Bearer super-secret" },
      { token: "super-secret", action: "opened" },
    );
    expect(dropped).toEqual({
      skipped: true,
      reason: "filter-not-matched",
      match: { source: "header", path: "Authorization" },
    });
    expect(JSON.stringify(dropped)).not.toContain("super-secret");

    const bodyMiss = miss(
      { filter: { body: { token: "expected" } } },
      {},
      { token: "super-secret" },
    );
    expect(bodyMiss).toEqual({ source: "body", path: "token" });
    expect(JSON.stringify(bodyMiss)).not.toContain("super-secret");

    expect(miss({ filter: { body: { action: "opened" } } }, {}, "not-json")).toEqual({
      source: "body",
      path: "action",
    });
    expect(
      miss({ filter: { body: { "pull_request.number": 1 } } }, {}, { action: "opened" }),
    ).toEqual({ source: "body", path: "pull_request.number" });
  });

  test("events stays an exact header allowlist and is AND-ed with filter", () => {
    const trigger = {
      events: ["pull_request"],
      filter: { body: { action: ["opened", "synchronize"] } },
    };
    allow(trigger, { "x-github-event": "pull_request" }, { action: "synchronize" });
    expect(skip(trigger, { "X-GitHub-Event": "push" }, { action: "opened" })).toEqual({
      skipped: true,
      reason: "event-not-allowed",
      event: "push",
    });
    expect(skip(trigger, {}, { action: "opened" })).toEqual({
      skipped: true,
      reason: "event-not-allowed",
      event: null,
    });
    expect(skip(trigger, { "x-github-event": "pull_request" }, { action: "closed" }).reason).toBe(
      "filter-not-matched",
    );
    allow({ events: [] }, { "x-github-event": "push" });
    allow({}, { "x-github-event": "push" });
  });

  test("eventHeader overrides the preset and the header name lookup stays case-insensitive", () => {
    const trigger = {
      preset: "gitlab" as const,
      eventHeader: "X-GitHub-Event",
      events: ["pull_request"],
    };
    allow(trigger, { "x-github-event": "pull_request" });
    expect(skip(trigger, { "X-Gitlab-Event": "pull_request" }).reason).toBe("event-not-allowed");
    allow(
      { events: ["Merge Request Hook"], eventHeader: "X-Gitlab-Event" },
      { "x-gitlab-event": "Merge Request Hook" },
    );
  });

  test("presets select the event field and do not filter on their own", () => {
    allow({ preset: "github" }, { "x-github-event": "push" }, { action: "closed" });
    allow(
      { preset: "gitlab", events: ["Merge Request Hook"] },
      { "x-gitlab-event": "Merge Request Hook" },
    );
    expect(
      skip(
        { preset: "gitlab", events: ["Merge Request Hook"] },
        { "x-github-event": "Merge Request Hook" },
      ),
    ).toEqual({ skipped: true, reason: "event-not-allowed", event: null });

    allow(
      { preset: "standard-webhooks", events: ["contact.created"] },
      {},
      { type: "contact.created", data: { id: "1" } },
    );
    expect(
      skip(
        { preset: "standard-webhooks", events: ["contact.created"] },
        {},
        { type: "user.deleted" },
      ),
    ).toEqual({ skipped: true, reason: "event-not-allowed", event: "user.deleted" });
    expect(
      skip({ preset: "standard-webhooks", events: ["contact.created"] }, {}, { data: {} }),
    ).toEqual({ skipped: true, reason: "event-not-allowed", event: null });
    allow({ preset: "standard-webhooks" }, {}, { type: "user.deleted" });
  });

  test("a corrupt preset, events list, event header, or filter fails closed", () => {
    expect(decideWebhookDelivery({ preset: "not-a-sender" }, {}, {})).toEqual({
      action: "invalid",
      message: WEBHOOK_PRESET_INVALID_MESSAGE,
    });
    expect(decideWebhookDelivery({ events: "pull_request" }, {}, {})).toEqual({
      action: "invalid",
      message: WEBHOOK_EVENTS_INVALID_MESSAGE,
    });
    expect(decideWebhookDelivery({ events: ["pull_request"], eventHeader: "" }, {}, {})).toEqual({
      action: "invalid",
      message: WEBHOOK_EVENT_HEADER_INVALID_MESSAGE,
    });
    expect(decideWebhookDelivery({ filter: { headers: { "X-GitHub-Event": 1 } } }, {}, {})).toEqual(
      { action: "invalid", message: WEBHOOK_FILTER_INVALID_MESSAGE },
    );
    expect(decideWebhookDelivery({ filter: {} }, {}, {})).toEqual({
      action: "invalid",
      message: WEBHOOK_FILTER_INVALID_MESSAGE,
    });
  });
});

describe("TriggerConfigSchema webhook filter", () => {
  test("accepts the GitHub header and action example", () => {
    const result = TriggerConfigSchema.safeParse({
      type: "webhook",
      preset: "github",
      events: ["pull_request"],
      filter: githubPullRequest,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "webhook") {
      expect(result.data.preset).toBe("github");
      expect(result.data.filter).toEqual(githubPullRequest);
    }
  });

  test("accepts GitLab and Standard Webhooks presets", () => {
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        preset: "gitlab",
        events: ["Merge Request Hook"],
        filter: { body: { "object_attributes.action": ["open", "reopen", "update"] } },
      }).success,
    ).toBe(true);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        preset: "standard-webhooks",
        events: ["contact.created"],
        filter: { body: { "data.id": "1" } },
      }).success,
    ).toBe(true);
  });

  test("rejects an empty filter, a duplicate header, a bad path, and an unknown preset", () => {
    expect(TriggerConfigSchema.safeParse({ type: "webhook", filter: {} }).success).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        filter: { headers: { "X-GitHub-Event": ["pull_request"], "x-github-event": ["push"] } },
      }).success,
    ).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        filter: { body: { "a..b": "x" } },
      }).success,
    ).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        filter: { body: { "a\nb": "x" } },
      }).success,
    ).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        filter: { body: { action: { nested: true } } },
      }).success,
    ).toBe(false);
    expect(
      TriggerConfigSchema.safeParse({
        type: "webhook",
        filter: { headers: { "X-GitHub-Event": ["pull_request"] }, events: ["push"] },
      }).success,
    ).toBe(false);
    expect(TriggerConfigSchema.safeParse({ type: "webhook", preset: "bitbucket" }).success).toBe(
      false,
    );

    const headers: Record<string, string> = {};
    for (let i = 0; i < 33; i++) headers[`X-Field-${i}`] = "a";
    expect(TriggerConfigSchema.safeParse({ type: "webhook", filter: { headers } }).success).toBe(
      false,
    );
  });
});
