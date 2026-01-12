# GitHub App Integration Implementation Plan

## Overview

Implement GitHub App integration for agent-swarm to enable webhook handling for PRs, issues, and comments, with `@agent-swarm` mention detection to create tasks for the lead agent to triage.

## Current State Analysis

### Existing Architecture
- **Backend**: Bun-based HTTP server (`src/http.ts`) with MCP and REST APIs
- **Database**: SQLite with schema in `src/be/db.ts`
- **Plugin System**: `plugin/commands/*.md` for Claude Code slash commands
- **Slack Integration**: `src/slack/` provides the pattern to follow

### Key Discoveries:
- Tasks have `source` field: `mcp | slack | api` - we add `github`
- Task schema has Slack metadata fields - we add GitHub equivalents
- `createTaskExtended()` in `src/be/db.ts:1040-1093` supports all needed options
- Lead agents receive tasks via `/api/poll` endpoint

## Desired End State

1. GitHub App sends webhooks to `POST /api/github/webhook`
2. Backend detects `@agent-swarm` mentions in PRs/issues/comments
3. Creates task for lead agent with full context (title, body, URL, author)
4. Tasks link back to GitHub via `githubUrl`, `githubRepo`, `githubNumber`
5. Agents respond using `/review-pr`, `/create-pr`, or `gh` CLI

### Verification:
- Create issue with `@agent-swarm` in body
- Task appears in dashboard with GitHub metadata
- Lead agent receives task via poll

## What We're NOT Doing

- No custom GitHub API wrapper (agents use `gh` CLI + MCP tools)
- No per-repo configuration (single instance-wide app via env vars)
- No dedicated GitHub frontend panel (tasks appear in existing Tasks panel)
- No special routing logic (all @mentions go to lead for triage)

---

## Phase 1: Database Schema & Types

### Overview
Add GitHub-specific fields to tasks table and update types.

### Changes Required:

#### 1. Update Types
**File**: `src/types.ts`
**Changes**: Add `github` to source enum, add GitHub metadata fields

```typescript
// Line ~13: Update source enum
export const AgentTaskSourceSchema = z.enum(["mcp", "slack", "api", "github"]);

// Add after line 53 (after slackUserId):
githubRepo: z.string().optional(),
githubEventType: z.string().optional(),
githubNumber: z.number().int().optional(),
githubCommentId: z.number().int().optional(),
githubAuthor: z.string().optional(),
githubUrl: z.string().optional(),
```

#### 2. Update Database Schema
**File**: `src/be/db.ts`
**Changes**: Add columns to CREATE TABLE, add migrations, update row types

Add migrations after line ~302:
```typescript
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubRepo TEXT`); } catch { /* exists */ }
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubEventType TEXT`); } catch { /* exists */ }
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubNumber INTEGER`); } catch { /* exists */ }
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubCommentId INTEGER`); } catch { /* exists */ }
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubAuthor TEXT`); } catch { /* exists */ }
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN githubUrl TEXT`); } catch { /* exists */ }
```

Update `AgentTaskRow`, `rowToAgentTask`, `CreateTaskOptions`, and `createTaskExtended`.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun tsc --noEmit`
- [ ] Database initializes: `bun run src/http.ts` starts without errors
- [ ] Tests pass: `bun test`

#### Manual Verification:
- [ ] New columns visible: `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks"`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: GitHub Webhook Handler Module

### Overview
Create `src/github/` module with webhook handler, following Slack pattern.

### Changes Required:

#### 1. Create GitHub Module
**Directory**: `src/github/`

**File**: `src/github/types.ts`
```typescript
export interface GitHubWebhookEvent {
  action: string;
  sender: { login: string };
  repository: { full_name: string; html_url: string };
  installation?: { id: number };
}

export interface PullRequestEvent extends GitHubWebhookEvent {
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
  };
}

export interface IssueEvent extends GitHubWebhookEvent {
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
  };
}

export interface CommentEvent extends GitHubWebhookEvent {
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { login: string };
  };
  issue?: { number: number; title: string; html_url: string };
  pull_request?: { number: number; title: string; html_url: string };
}
```

**File**: `src/github/app.ts`
- `isGitHubEnabled()` - checks `GITHUB_WEBHOOK_SECRET` env var
- `initGitHub()` - initialization with logging
- `verifyWebhookSignature()` - HMAC SHA-256 signature verification

**File**: `src/github/mentions.ts`
- `detectMention(text)` - returns true if `@agent-swarm` found
- `extractMentionContext(text)` - removes mention, returns rest

**File**: `src/github/handlers.ts`
- `handlePullRequest(event)` - creates task for PR with @mention
- `handleIssue(event)` - creates task for issue with @mention
- `handleComment(event)` - creates task for comment with @mention
- All handlers: find lead agent, create task with GitHub metadata

**File**: `src/github/index.ts`
- Re-exports all public functions

#### 2. Add Webhook Endpoint
**File**: `src/http.ts`
**Changes**: Add `POST /api/github/webhook` endpoint after `/ecosystem`

- Verify signature via `x-hub-signature-256` header
- Route events: `pull_request`, `issues`, `issue_comment`, `pull_request_review_comment`
- Handle `ping` event for webhook setup verification
- Return 503 if GitHub not enabled, 401 if invalid signature

Add `initGitHub()` call in server startup after `startSlackApp()`.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun tsc --noEmit`
- [ ] Server starts: `bun run src/http.ts`
- [ ] Tests pass: `bun test`

#### Manual Verification:
- [ ] Without GITHUB_WEBHOOK_SECRET, endpoint returns 503
- [ ] With secret set, ping webhook accepted

**Implementation Note**: After completing this phase, pause for manual webhook testing before proceeding.

---

## Phase 3: Claude Code Commands for GitHub

### Overview
Add Claude Code slash commands for common GitHub operations.

### Changes Required:

#### 1. `/review-pr` Command
**File**: `plugin/commands/review-pr.md`
- Fetch PR details with `gh pr view` and `gh pr diff`
- Analyze changes for issues (security, logic, performance, style)
- Provide structured review with summary, findings, verdict
- Optionally post review with `gh pr review`

#### 2. `/create-pr` Command
**File**: `plugin/commands/create-pr.md`
- Gather branch info and commits
- Generate PR title and description
- Create PR with `gh pr create`

#### 3. `/close-issue` Command
**File**: `plugin/commands/close-issue.md`
- Get issue details
- Generate closing comment
- Close with `gh issue close`

#### 4. `/respond-github` Command
**File**: `plugin/commands/respond-github.md`
- Get issue/PR context
- Formulate response
- Post with `gh issue comment` or `gh pr comment`

### Success Criteria:

#### Automated Verification:
- [ ] Command files exist in `plugin/commands/`

#### Manual Verification:
- [ ] `/review-pr 123` fetches and analyzes PR
- [ ] `/create-pr` generates PR from current branch
- [ ] Commands work in agent context

---

## Phase 4: Environment Variables & Documentation

### Overview
Document required env vars and create GitHub App setup guide.

### Changes Required:

#### 1. Update .env.example
**File**: `.env.example`
```bash
# GitHub App Integration (optional)
# GITHUB_DISABLE=true  # Set to skip GitHub integration
GITHUB_WEBHOOK_SECRET=  # Webhook secret from GitHub App settings
```

#### 2. Add Unit Tests
**File**: `src/github/mentions.test.ts`
- Test `detectMention()` with various inputs
- Test `extractMentionContext()` removes mention correctly

### Success Criteria:

#### Automated Verification:
- [ ] .env.example updated
- [ ] Unit tests pass: `bun test src/github/mentions.test.ts`

#### Manual Verification:
- [ ] End-to-end: Create GitHub App, install on repo, mention @agent-swarm, verify task created

---

## Testing Strategy

### Unit Tests:
- `src/github/mentions.test.ts`: Mention detection patterns

### Integration Tests:
- Extend `src/tests/rest-api.test.ts` with webhook endpoint tests

### Manual Testing Steps:
1. Create GitHub App with webhook URL and secret
2. Install on test repo
3. Create issue with `@agent-swarm` in body
4. Verify task appears in dashboard
5. Verify lead agent receives task via poll
6. Test `/review-pr` command manually

## Performance Considerations

- Event deduplication with 60-second TTL prevents duplicate task creation
- Signature verification uses timing-safe comparison

## Migration Notes

- Database migrations are additive (new columns only)
- Existing tasks unaffected (new fields are optional/nullable)

## References

- Slack integration pattern: `src/slack/handlers.ts:139-280`
- Task creation: `src/be/db.ts:1040-1093`
- Plugin commands: `plugin/commands/*.md`
