# Exa Search

Exa (https://exa.ai) is a neural/semantic search API. It returns web results ranked by embedding similarity rather than keyword match — much better than Google for "find me companies that sound like X" or "what papers explore the shape of Y."

## When to use Exa vs. WebSearch

| Query shape | Use |
|---|---|
| "What is the official Bun docs URL?" | WebSearch (concrete lookup) |
| "Latest CVE for Next.js" | WebSearch (recent, factual) |
| "Companies building post-hierarchy AI org platforms" | **Exa** (conceptual / discovery) |
| "Papers on Bayesian memory rating for agents" | **Exa** (topic-shape) |
| "Blogs that argue knowledge ≠ data in agent systems" | **Exa** (argument-shape) |
| "Funding rounds for company X in 2026" | WebSearch (named entity + date) |

Rule of thumb: if you're tempted to run 5+ WebSearch calls rephrasing the same idea, use Exa instead — one neural query usually surfaces the cluster.

## Step 1 — Get the API key

```bash
# Via MCP tool (preferred — handles secret resolution)
mcp__agent-swarm__get-config(key="EXA_API_KEY", includeSecrets=true)
```

The value comes back at `configs[0].value`. Export to env or pass inline.

## Step 2 — Call the search endpoint

Endpoint: `POST https://api.exa.ai/search` — full reference at https://exa.ai/docs/reference/search

```bash
curl -X POST 'https://api.exa.ai/search' \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "companies building agent coordination layers for enterprises",
    "type": "neural",
    "numResults": 10,
    "useAutoprompt": true
  }'
```

Key request fields:
- `query` (required): the natural-language description, NOT keywords
- `type`: `"neural"` (semantic, default for discovery) or `"keyword"` (legacy) or `"auto"` (let Exa choose)
- `numResults`: 1–25, default 10
- `useAutoprompt`: true → Exa rewrites your query for better embedding match (recommended for short/colloquial queries)
- `includeDomains` / `excludeDomains`: arrays for filtering
- `startPublishedDate` / `endPublishedDate`: ISO dates for time-bounding
- `category`: e.g. `"company"`, `"research paper"`, `"news"`, `"github"`, `"tweet"`, `"pdf"` — narrows the result type

Response shape (trimmed):
```json
{
  "results": [
    { "title": "...", "url": "...", "publishedDate": "...", "author": "...", "score": 0.42, "id": "..." }
  ],
  "autopromptString": "the rewritten query Exa actually used"
}
```

## Step 3 — (Optional) Get full content

The `/search` endpoint returns metadata only. To pull article bodies:

```bash
curl -X POST 'https://api.exa.ai/contents' \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "ids": ["result-id-from-search"],
    "text": true
  }'
```

Or use the one-shot `/search` variant with `"contents": { "text": true }` baked into the search request to get content in a single round-trip.

## Step 4 — Pair with WebFetch for verification

Exa surfaces candidates fast but its content snippets can be stale or truncated. For any claim you'll cite (funding amount, headcount, product description), follow up with WebFetch on the canonical company URL. Treat Exa as a discovery layer, WebFetch as the source of truth.

## Discipline — no fabrication

If a query returns no relevant results, **say "not surfaced"** in your output rather than inventing plausible-sounding companies/papers/links. The most common Exa failure mode is over-promising a comprehensive landscape when the embedding space had thin coverage of your topic. Marking gaps explicitly is what makes the research trustworthy.

## Real-world example queries (from 2026-05-04 swarm competitive analysis)

These are the exact queries the Researcher used to map the agent-coordination landscape:

- `"multi-agent platform for enterprises"`
- `"AI org operating system post-hierarchy intelligence"`
- `"AI employee platform digital workers"`
- `"derived knowledge layer for AI agents"`
- `"agent coordination layer routes work specialist"`
- `"humans at the edge AI org structure"`
- `"agent capability gap registry knowledge graph"`

Each surfaced 8–12 results; combined with WebFetch on company sites and WebSearch for funding numbers, the Researcher mapped 5 staked competitive slots + 1 open quadrant in ~30 min. See `agent-fs --org 648a5f3c-35c8-4f11-8673-b89de52cd6bd cat thoughts/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/research/2026-05-04-swarm-competitive-analysis.md` for the full output.

## Quick gotchas

- The header is `x-api-key`, **not** `Authorization: Bearer`.
- Free-tier rate limits are tight — batch your queries, don't fire dozens.
- Neural search is non-deterministic across calls; same query can shuffle top-5 results.
- `useAutoprompt: true` is almost always right; only disable if you've already hand-tuned the query.

