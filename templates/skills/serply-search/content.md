# Serply Search

Serply (https://serply.io) is a Google SERP API. It returns the ranked organic results for a keyword query, and exposes Google News and Google Scholar as separate endpoints. API reference: https://serply.io/docs

## When to use Serply vs. Exa vs. WebSearch

| Query shape | Use |
|---|---|
| "Companies building agent coordination layers" | Exa (conceptual, embedding match) |
| "Blogs that argue knowledge is not data" | Exa (argument-shape) |
| "What ranks on page 1 for `bun sqlite orm`" | **Serply** search (the ranking is the answer) |
| "Funding rounds for company X since June" | **Serply** news (named entity plus date) |
| "How heavily cited is paper Y" | **Serply** scholar (citation counts) |
| "What is the official Bun docs URL?" | WebSearch (one concrete lookup) |

Exa ranks by embedding similarity, so it wins at "find me things shaped like this". Serply returns what Google actually ranks, which is what you want when position, recency, or citation weight is the thing being measured. A plain WebSearch is still the cheapest way to settle a single fact.

## Step 1. Get the API key

```bash
# Via MCP tool (preferred, handles secret resolution)
mcp__agent-swarm__get-config(key="SERPLY_API_KEY", includeSecrets=true)
```

The value comes back at `configs[0].value`. Export to env or pass inline. Keys come from https://serply.io

## Step 2. Web search

```bash
curl -sS 'https://api.serply.io/v1/search/?q=bun+sqlite+orm&num=10' \
  -H "X-Api-Key: $SERPLY_API_KEY" \
  -H 'User-Agent: agent-swarm/1.0'
```

Parameters go in the query string:

- `q` (required): URL-encoded keywords, not a natural-language description. Google operators pass straight through, so `q=sqlite+site%3Abun.sh` and `tbs=` date filters behave as they do in the browser.
- `num`: how many results to return. Honored up to 10 and clamped there, so page instead of asking for 20.

Response (trimmed):

```json
{
  "results": [
    {
      "title": "Use Drizzle ORM with Bun | Bun Guides",
      "description": "Drizzle is an ORM that supports both a SQL-like \"query builder\" API and an ORM-like Queries API.",
      "position": 1,
      "realPosition": 1,
      "result_type": "organic",
      "link": "https://bun.com/guides/ecosystem/drizzle"
    }
  ]
}
```

The snippet field is `description`, not `snippet`, and the URL field is `link`, not `url`. Each row also carries `metadata.display_url`. The payload has `answers`, `knowledge_graph` and `related_questions` beside `results`, populated only when Google returned them and empty otherwise.

## Step 3. News and scholar

Same host and header, different path, different response key.

```bash
curl -sS 'https://api.serply.io/v1/news/?q=openai+funding' \
  -H "X-Api-Key: $SERPLY_API_KEY" -H 'User-Agent: agent-swarm/1.0'
```

News rows land in `entries[]`, each with `title`, `link`, `published` (RFC 1123), `summary`, and `source.title`. It returns the whole feed and ignores `num`.

```bash
curl -sS 'https://api.serply.io/v1/scholar/?q=attention+is+all+you+need&num=3' \
  -H "X-Api-Key: $SERPLY_API_KEY" -H 'User-Agent: agent-swarm/1.0'
```

Scholar rows land in `articles[]`, each with `title`, `link`, `description`, `author.names`, and `extras.citations.count` as a string like `"Cited by 269516"`. When Google found a PDF, `doc.link` points at it.

## Step 4. Pair with WebFetch

A SERP row gives you a title, a snippet, and a rank. For anything you will cite, fetch the page. Serply is the index, WebFetch is the source.

## Discipline: no fabrication

If a query surfaces nothing relevant, write "not surfaced" rather than inventing a plausible link. A search that came back thin is a real finding and worth reporting as one.

## Quick gotchas

- The header is `X-Api-Key` holding the bare key, **not** `Authorization: Bearer`.
- Serply sits behind Cloudflare, which rejects a default library User-Agent. Python `urllib` gets `HTTP 403` with the body `error code: 1010`. Send an explicit `User-Agent`; curl's own default is accepted.
- `/v1/scholar/` returns both `articles` and an empty `results: []`. Read `articles`. Reading `results` gives you zero papers for every query, and nothing about the response says why.
- Rankings are location-dependent, so two runs from different regions can legitimately disagree. Record the query alongside the positions whenever the position is the point.
