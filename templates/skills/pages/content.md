# Pages

Pages are persistent, shareable HTML documents created via the swarm's `create_page` MCP tool. Use them when the output benefits from layout, tables, headers, and persistent sharing — unlike Slack messages, pages don't expire and can be bookmarked.

## When to Create a Page

- A report, dashboard, or summary that benefits from structured layout
- Analysis that should be linkable and bookmarkable
- Results that need to be reviewed asynchronously (not in a Slack thread)
- Content that's too long or rich for a `store-progress.output` string

Do NOT use pages for:
- In-flight progress notes (use `store-progress.progress`)
- Sensitive data (credentials, private customer data)
- Large binary files (use agent-fs for PNG/MP4)

## Creating a Page

```javascript
// Via MCP tool
create_page({
  title: "Q2 SEO Performance Report",
  content: `<h1>Q2 SEO Performance</h1>
<p>Analysis period: 2026-04-01 to 2026-06-30</p>
<h2>Summary</h2>
<table>
  <tr><th>Metric</th><th>Q1</th><th>Q2</th><th>Change</th></tr>
  <tr><td>Organic clicks</td><td>12,400</td><td>18,600</td><td>+50%</td></tr>
</table>
<h2>Next Actions</h2>
<ul>
  <li>Publish 3 new pillar pages targeting high-intent queries</li>
  <li>Fix 23 pages with missing meta descriptions</li>
</ul>`
})
```

Returns a page ID. Build the share URL:
```
${APP_URL}/pages/<pageId>           # opens in SPA with chrome
${APP_URL}/pages/<pageId>?mode=full # slim header, full viewport
${MCP_BASE_URL}/p/<pageId>          # direct HTML (no SPA)
```

Read `APP_URL` and `MCP_BASE_URL` from environment — never hardcode.

## Content Guidelines

**Keep raw evidence in artifacts and link to it.** The page should contain:
1. **Short summary** (1 paragraph) — what this covers and the key finding
2. **Source links** — links to the data, agent-fs artifacts, or upstream systems
3. **Structured content** — tables, headers, numbered lists
4. **Next actions** — what should happen next, who owns it

Do NOT embed:
- Secrets or private credentials
- Personal data of individuals without approval
- Raw verbose logs (summarize them)

## Page vs. Agent-fs

| Use pages for | Use agent-fs for |
|---|---|
| Reports, dashboards, human-readable summaries | Markdown research notes, code files, recordings |
| Content that benefits from HTML layout | Searchable knowledge base entries |
| Quick share links to non-technical stakeholders | Binary artifacts (PNG, MP4) |
| Time-bounded deliverables | Long-lived reference documentation |

## Sharing Pages

Always use the platform share URL (from `APP_URL` env var) rather than hardcoded local hosts. Append `?mode=full` for a standalone view (hides sidebar/header — good for screenshots or embedding in Slack previews).

```bash
# Get the share URL
PAGE_URL="${APP_URL}/pages/${pageId}?mode=full"

# Post to Slack
slack-reply --taskId <id> --message "Report ready: ${PAGE_URL}"
```

## Trade-offs

**Pages vs Slack messages:** Slack messages are ephemeral and scroll out of view. Pages are persistent and bookmarkable. Use pages for anything you'd want to reference in 3 months; use Slack for in-the-moment communication.

**Pages vs agent-fs:** Pages are rendered HTML with a share URL — great for non-technical stakeholders. Agent-fs files are raw content — great for other agents and developers who need the source data. For a research memo, write the source to agent-fs and create a page for the human-facing summary.
