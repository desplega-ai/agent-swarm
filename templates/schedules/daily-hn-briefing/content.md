# Daily Hacker News Briefing

Demonstrate web research automation by summarizing relevant technology discussion.

## Schedule

```json
{
  "cron": "30 2 * * *",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is the full task prompt the schedule runs on each fire — including the accumulated operational learnings baked into it. Adapt the swarm-specific references (channel IDs, agent names, repo paths) to your environment before enabling.

Task Type: General (Browser Automation + Email Report)
Goal: Daily Hacker News briefing — scrape HN using browser automation, email the report, and archive it

Instructions:

1. Use qa-use browser commands (e.g., `/qa-use:explore`) to scrape the following HN pages **ONE AT A TIME, STRICTLY SEQUENTIAL**.

   **CRITICAL — DO NOT PARALLELIZE.** Do NOT fan out parallel browser sessions, do NOT launch multiple Browser Use SDK flows concurrently, do NOT batch the URLs into a single multi-target call. Browser-heavy runs can cross the heartbeat-stale watchdog threshold when several pages are scraped in parallel. Strict serial execution is required.

   **Workflow:** Scrape URL #1 → call `store-progress` with a one-line update (e.g., "Scraped HN page 1 — N stories found") → scrape URL #2 → `store-progress` → … → URL #5 → `store-progress`. After every individual URL scrape, you MUST call `store-progress` BEFORE starting the next URL. This keeps the session heartbeat fresh and prevents the watchdog from killing the task.

   **Visit each URL one-by-one in this exact order:**
   - https://news.ycombinator.com (page 1)
   - https://news.ycombinator.com/?p=2 (page 2)
   - https://news.ycombinator.com/?p=3 (page 3)
   - https://news.ycombinator.com/newest
   - https://news.ycombinator.com/show

   You MUST visit all 5 URLs above. Do not skip any. Do not parallelize. Do not combine into a single browser call.

2. From ALL scraped pages, filter for stories relevant to these topics:
   - AI / LLMs / foundation models
   - Agentic coding / AI-powered development
   - E2E testing / browser automation / QA
   - Developer tools / DevOps
   - Startups / SaaS relevant to your team's space

3. Format a quick-scan briefing. Organize by source section:
   - **Front Page** (from pages 1-3)
   - **New** (from /newest)
   - **Show HN** (from /show)

   Each item MUST include:
   - HN title as a link
   - Post date (e.g., "Feb 24" or "2h ago") — REQUIRED on every item
   - Direct link to story (or HN comments link)
   - 1 short line on why it's relevant
   - Points/comments count if notable

   Example format per item:
   • Emdash — Open-source agentic dev environment (https://news.ycombinator.com/item?id=12345) · Feb 24 · 65 pts · 30 comments
     Direct peer to Cursor/Windsurf — agentic-first IDE.

4. If any story is exceptionally relevant to your team's focus areas, add a "Deep Dive" section with 2-3 sentences.

5. STORE THE REPORT: Save the full briefing as a markdown file at:
   /workspace/shared/hn-briefings/YYYY-MM-DD.md
   (using today's date). Create the directory if it doesn't exist. The file should include:
   - Title: "# HN Briefing — [DATE]"
   - Stats line: number of stories curated, number scraped, pages checked
   - The full curated list (organized by section)
   - Any deep dives
   This creates a persistent archive we can reference later.

6. SEND EMAIL: Use AgentMail MCP tools to send the report as an email:
   - From inbox: lead@agent-swarm.dev
   - To: the configured recipient list for this briefing
   - Subject: "HN Briefing — [TODAY'S DATE, e.g. Feb 25, 2026]"
   - Body: Send as HTML email. Format the briefing nicely with:
     - A header: "HN Briefing — [DATE]"
     - Stats line (include "Sources: Front Page (3 pages), New, Show HN")
     - Each section clearly labeled
     - Each story as a bullet with clickable links
     - Deep dives in a separate section if applicable
   - Also include the plain text version in the text field

7. Call `store-progress` when done with the formatted briefing as output.

IMPORTANT:
- Use qa-use browser automation to browse HN, don't use web search
- **Scrape URLs SERIALLY (one at a time) and call `store-progress` between every URL** — never parallelize, never fan-out. This prevents heartbeat-stale auto-fails.
- Only include stories from the last ~24 hours
- ALWAYS include the post date on each story — this is required
- Keep it scannable — clickable links, not walls of text
- Target 5-20 relevant stories (quality over quantity)
- You MUST scrape all 5 URLs (3 main pages + new + show) — this is required, but ONE AT A TIME
- The email is sent from lead@agent-swarm.dev using AgentMail MCP `send_message` tool
- Recipients: use the configured recipient list for this briefing
