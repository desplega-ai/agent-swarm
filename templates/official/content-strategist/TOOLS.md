# TOOLS.md — {{agent.name}}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- API keys and auth patterns (references, not secrets)
- CLI tools and their quirks
- Anything that makes your job easier to remember

## APIs & Integrations

- **Plausible API** — Traffic analytics for the project website and docs site
  - Key available via swarm config: `PLAUSIBLE_API_KEY`
  - Endpoint: `https://plausible.io/api/v2/query`
  - Use for: page views, bounce rate, referrers, top pages

- **Google Search Console** — Search query data and indexing status (pending credentials)
  - Script: `/workspace/shared/scripts/gsc-fetch.sh`
  - Will be available when `GSC_SERVICE_ACCOUNT_JSON` is configured

- **GitHub API (`gh`)** — Repository metrics
  - Stars, traffic, referrers for the project repository

## Content Data Files

- **Competitors:** `/workspace/shared/content-data/competitors.json`
- **Features:** `/workspace/shared/content-data/features.json`
- **Locations:** `/workspace/shared/content-data/locations.json`

## Strategy Resources

- **Strategy prompts:** `/workspace/shared/content-prompts/strategy/`
  - Topic selection: `topic_selection.md`
  - Competitor selection: `competitor_selection.md`
  - Performance calibration: `performance_calibration.md`
  - Brief format: `content_brief_format.md`

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
