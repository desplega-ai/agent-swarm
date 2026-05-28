# Exa Search

Exa (https://exa.ai) is a neural/semantic search API. It returns web results ranked by embedding similarity rather than keyword match — much better for "find me companies that sound like X" or "what papers explore the shape of Y."

## When to Use Exa vs. WebSearch

| Query shape | Use |
|---|---|
| "What is the official Bun docs URL?" | WebSearch (concrete lookup) |
| "Latest CVE for Next.js" | WebSearch (recent, factual) |
| "Companies building post-hierarchy AI org platforms" | **Exa** (conceptual / discovery) |
| "Papers on Bayesian memory rating for agents" | **Exa** (topic-shape) |
| "Blogs that argue knowledge ≠ data in agent systems" | **Exa** (argument-shape) |

Rule of thumb: if you're tempted to run 5+ WebSearch calls rephrasing the same idea, use Exa instead — one neural query usually surfaces the cluster.

## Step 1 — Get the API Key

```bash
# Via MCP tool
mcp__agent-swarm__get-config(key="EXA_API_KEY", includeSecrets=true)
```

The value comes back at `configs[0].value`.

## Step 2 — Call the Search Endpoint

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
- `query` (required): natural-language description, NOT keywords
- `type`: `"neural"` (semantic) or `"keyword"` (legacy) or `"auto"`
- `numResults`: 1–25, default 10
- `useAutoprompt`: true → Exa rewrites your query for better embedding match (recommended)
- `includeDomains` / `excludeDomains`: arrays for filtering
- `startPublishedDate` / `endPublishedDate`: ISO dates for time-bounding
- `category`: e.g. `"company"`, `"research paper"`, `"news"`, `"github"`

Response shape:
```json
{
  "results": [
    { "title": "...", "url": "...", "publishedDate": "...", "score": 0.42 }
  ],
  "autopromptString": "the rewritten query Exa actually used"
}
```

## Step 3 — (Optional) Get Full Content

```bash
curl -X POST 'https://api.exa.ai/contents' \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "ids": ["result-id-from-search"],
    "text": true
  }'
```

Or embed `"contents": {"text": true}` in the `/search` request for a single round-trip.

## Step 4 — Pair with WebFetch for Verification

Exa surfaces candidates fast but its content snippets can be stale. For any claim you'll cite (funding amount, headcount, product description), follow up with WebFetch on the canonical URL. Treat Exa as a discovery layer, WebFetch as the source of truth.

## Discipline — No Fabrication

If a query returns no relevant results, **say "not surfaced"** rather than inventing plausible-sounding companies/papers/links. The most common Exa failure mode is over-promising coverage when the embedding space is thin.

## Quick Gotchas

- The header is `x-api-key`, **not** `Authorization: Bearer`.
- Free-tier rate limits are tight — batch your queries.
- Neural search is non-deterministic; same query can shuffle top-5 results.
- `useAutoprompt: true` is almost always right; only disable if you've hand-tuned the query.

## Trade-offs

**Neural search is probabilistic, not exhaustive.** For "find every instance of X" type queries, use grep or a more structured data source. For "find things that sound like X across the web," Exa is the right tool and saves many WebSearch round-trips.
