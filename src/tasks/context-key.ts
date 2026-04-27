/**
 * Cross-ingress task context keys.
 *
 * Every ingress surface (Slack, GitHub, GitLab, AgentMail, Linear, schedules,
 * workflows, ...) builds a uniform string key that identifies the "context entity"
 * a task belongs to. We persist the key on `agent_tasks.contextKey` so that a
 * single indexed lookup can return all sibling tasks for a given entity.
 *
 * Key schema:
 *   task:slack:{channelId}:{threadTs}
 *   task:agentmail:{threadId}
 *   task:trackers:github:{owner}:{repo}:{issue|pr}:{number}
 *   task:trackers:gitlab:{projectId}:{mr|issue}:{iid}
 *   task:trackers:linear:{issueIdentifier}        (e.g. DES-42 — case preserved)
 *   task:trackers:jira:{issueIdentifier}          (e.g. PROJ-123 — case preserved)
 *   task:schedule:{scheduleId}
 *   task:workflow:{workflowRunId}
 *
 * Rules:
 *   - Fixed prefix tokens (`task`, family, sub-family, kind) are always lowercase.
 *   - Case is preserved inside identifier portions so Linear identifiers and
 *     GitHub repo slugs round-trip exactly.
 *   - `:` is the separator and forbidden in any embedded value. Callers must
 *     sanitize first; unsanitized inputs throw so bugs surface loudly at the
 *     ingress boundary rather than creating silent mis-keyed tasks.
 *   - `null`/`undefined`/empty values throw — a context key either exists
 *     fully or not at all.
 */

const SEPARATOR = ":";

export type ContextKeyFamily = "slack" | "agentmail" | "trackers" | "schedule" | "workflow";

export type TrackerProvider = "github" | "gitlab" | "linear" | "jira";

export type ParsedContextKey =
  | { family: "slack"; parts: { channelId: string; threadTs: string } }
  | { family: "agentmail"; parts: { threadId: string } }
  | {
      family: "trackers";
      subFamily: "github";
      parts: { owner: string; repo: string; kind: "issue" | "pr"; number: number };
    }
  | {
      family: "trackers";
      subFamily: "gitlab";
      parts: { projectId: string; kind: "mr" | "issue"; iid: number };
    }
  | {
      family: "trackers";
      subFamily: "linear";
      parts: { issueIdentifier: string };
    }
  | {
      family: "trackers";
      subFamily: "jira";
      parts: { issueIdentifier: string };
    }
  | { family: "schedule"; parts: { scheduleId: string } }
  | { family: "workflow"; parts: { workflowRunId: string } };

function assertSafePart(value: unknown, label: string): string {
  if (value === null || value === undefined) {
    throw new Error(`context-key: "${label}" is required`);
  }
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) {
    throw new Error(`context-key: "${label}" must be non-empty`);
  }
  if (str.includes(SEPARATOR)) {
    throw new Error(
      `context-key: "${label}" must not contain "${SEPARATOR}"; caller must sanitize (got ${JSON.stringify(str)})`,
    );
  }
  return str;
}

export function slackContextKey(input: { channelId: string; threadTs: string }): string {
  const channelId = assertSafePart(input.channelId, "channelId");
  const threadTs = assertSafePart(input.threadTs, "threadTs");
  return ["task", "slack", channelId, threadTs].join(SEPARATOR);
}

export function agentmailContextKey(input: { threadId: string }): string {
  const threadId = assertSafePart(input.threadId, "threadId");
  return ["task", "agentmail", threadId].join(SEPARATOR);
}

export function githubContextKey(input: {
  owner: string;
  repo: string;
  kind: "issue" | "pr";
  number: number;
}): string {
  const owner = assertSafePart(input.owner, "owner");
  const repo = assertSafePart(input.repo, "repo");
  const kind = assertSafePart(input.kind, "kind").toLowerCase();
  if (kind !== "issue" && kind !== "pr") {
    throw new Error(
      `context-key: github "kind" must be "issue" or "pr" (got ${JSON.stringify(kind)})`,
    );
  }
  const number = assertSafePart(input.number, "number");
  if (!/^\d+$/.test(number)) {
    throw new Error(
      `context-key: github "number" must be a positive integer (got ${JSON.stringify(number)})`,
    );
  }
  return ["task", "trackers", "github", owner, repo, kind, number].join(SEPARATOR);
}

export function gitlabContextKey(input: {
  projectId: string | number;
  kind: "mr" | "issue";
  iid: number;
}): string {
  const projectId = assertSafePart(input.projectId, "projectId");
  const kind = assertSafePart(input.kind, "kind").toLowerCase();
  if (kind !== "mr" && kind !== "issue") {
    throw new Error(
      `context-key: gitlab "kind" must be "mr" or "issue" (got ${JSON.stringify(kind)})`,
    );
  }
  const iid = assertSafePart(input.iid, "iid");
  if (!/^\d+$/.test(iid)) {
    throw new Error(
      `context-key: gitlab "iid" must be a positive integer (got ${JSON.stringify(iid)})`,
    );
  }
  return ["task", "trackers", "gitlab", projectId, kind, iid].join(SEPARATOR);
}

export function linearContextKey(input: { issueIdentifier: string }): string {
  const issueIdentifier = assertSafePart(input.issueIdentifier, "issueIdentifier");
  return ["task", "trackers", "linear", issueIdentifier].join(SEPARATOR);
}

/**
 * Build a Jira tracker context key. Plan Phase 1 names this `buildJiraContextKey`
 * (positional `issueIdentifier`) rather than the `<provider>ContextKey({input})`
 * shape used by older builders. New ingress sites should prefer this signature;
 * the existing Linear/GitHub/GitLab builders are kept as-is to avoid touching
 * unrelated call sites.
 */
export function buildJiraContextKey(issueIdentifier: string): string {
  const id = assertSafePart(issueIdentifier, "issueIdentifier");
  return ["task", "trackers", "jira", id].join(SEPARATOR);
}

export function scheduleContextKey(input: { scheduleId: string }): string {
  const scheduleId = assertSafePart(input.scheduleId, "scheduleId");
  return ["task", "schedule", scheduleId].join(SEPARATOR);
}

export function workflowContextKey(input: { workflowRunId: string }): string {
  const workflowRunId = assertSafePart(input.workflowRunId, "workflowRunId");
  return ["task", "workflow", workflowRunId].join(SEPARATOR);
}

/**
 * Parse a context key back into a structured form. Throws on malformed input.
 * Useful for diagnostics and downstream routing; not used on the hot insert path.
 */
export function parseContextKey(key: string): ParsedContextKey {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("context-key: key must be a non-empty string");
  }
  const parts = key.split(SEPARATOR);
  if (parts.length < 3 || parts[0] !== "task") {
    throw new Error(`context-key: malformed key (expected "task:..."): ${JSON.stringify(key)}`);
  }
  const family = parts[1];
  switch (family) {
    case "slack": {
      if (parts.length !== 4) {
        throw new Error(`context-key: malformed slack key: ${JSON.stringify(key)}`);
      }
      return {
        family: "slack",
        parts: { channelId: parts[2] as string, threadTs: parts[3] as string },
      };
    }
    case "agentmail": {
      if (parts.length !== 3) {
        throw new Error(`context-key: malformed agentmail key: ${JSON.stringify(key)}`);
      }
      return { family: "agentmail", parts: { threadId: parts[2] as string } };
    }
    case "schedule": {
      if (parts.length !== 3) {
        throw new Error(`context-key: malformed schedule key: ${JSON.stringify(key)}`);
      }
      return { family: "schedule", parts: { scheduleId: parts[2] as string } };
    }
    case "workflow": {
      if (parts.length !== 3) {
        throw new Error(`context-key: malformed workflow key: ${JSON.stringify(key)}`);
      }
      return { family: "workflow", parts: { workflowRunId: parts[2] as string } };
    }
    case "trackers": {
      const subFamily = parts[2];
      if (subFamily === "github") {
        if (parts.length !== 7) {
          throw new Error(`context-key: malformed github key: ${JSON.stringify(key)}`);
        }
        const owner = parts[3] as string;
        const repo = parts[4] as string;
        const kind = parts[5];
        const numberStr = parts[6] as string;
        if (kind !== "issue" && kind !== "pr") {
          throw new Error(`context-key: malformed github kind "${kind}": ${JSON.stringify(key)}`);
        }
        const number = Number.parseInt(numberStr, 10);
        if (!Number.isFinite(number)) {
          throw new Error(
            `context-key: malformed github number "${numberStr}": ${JSON.stringify(key)}`,
          );
        }
        return {
          family: "trackers",
          subFamily: "github",
          parts: { owner, repo, kind, number },
        };
      }
      if (subFamily === "gitlab") {
        if (parts.length !== 6) {
          throw new Error(`context-key: malformed gitlab key: ${JSON.stringify(key)}`);
        }
        const projectId = parts[3] as string;
        const kind = parts[4];
        const iidStr = parts[5] as string;
        if (kind !== "mr" && kind !== "issue") {
          throw new Error(`context-key: malformed gitlab kind "${kind}": ${JSON.stringify(key)}`);
        }
        const iid = Number.parseInt(iidStr, 10);
        if (!Number.isFinite(iid)) {
          throw new Error(`context-key: malformed gitlab iid "${iidStr}": ${JSON.stringify(key)}`);
        }
        return {
          family: "trackers",
          subFamily: "gitlab",
          parts: { projectId, kind, iid },
        };
      }
      if (subFamily === "linear") {
        if (parts.length !== 4) {
          throw new Error(`context-key: malformed linear key: ${JSON.stringify(key)}`);
        }
        return {
          family: "trackers",
          subFamily: "linear",
          parts: { issueIdentifier: parts[3] as string },
        };
      }
      if (subFamily === "jira") {
        if (parts.length !== 4) {
          throw new Error(`context-key: malformed jira key: ${JSON.stringify(key)}`);
        }
        return {
          family: "trackers",
          subFamily: "jira",
          parts: { issueIdentifier: parts[3] as string },
        };
      }
      throw new Error(
        `context-key: unknown trackers sub-family "${subFamily}": ${JSON.stringify(key)}`,
      );
    }
    default:
      throw new Error(`context-key: unknown family "${family}": ${JSON.stringify(key)}`);
  }
}
